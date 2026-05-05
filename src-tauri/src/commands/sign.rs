use der::Encode;
use lopdf::{dictionary, Document, Object, ObjectId, StringFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x509_cert::{der::Decode, Certificate};

use super::pkcs11::pkcs11_sign;

const CONTENTS_PLACEHOLDER_LEN: usize = 16384; // bytes reserved for CMS blob

#[derive(Debug, Deserialize)]
pub struct SignOptions {
    pub slot_id: u64,
    pub cert_der: Vec<u8>,
    pub pin: String,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub signer_name: Option<String>,
    pub ts_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SignResult {
    pub signed_pdf: Vec<u8>,
}

#[tauri::command]
pub async fn sign_pdf(pdf_bytes: Vec<u8>, options: SignOptions) -> Result<SignResult, String> {
    let signed = do_sign(&pdf_bytes, &options)?;
    Ok(SignResult { signed_pdf: signed })
}

fn do_sign(pdf_bytes: &[u8], opts: &SignOptions) -> Result<Vec<u8>, String> {
    do_sign_with(pdf_bytes, opts, |digest| {
        pkcs11_sign(&opts.cert_der, opts.slot_id, digest, &opts.pin)
    })
}

/// Core pipeline with an injectable signer — used directly in tests.
pub(crate) fn do_sign_with<F>(pdf_bytes: &[u8], opts: &SignOptions, signer: F) -> Result<Vec<u8>, String>
where
    F: FnOnce(&[u8]) -> Result<Vec<u8>, String>,
{
    // ── Step 1: parse existing PDF and append a /Sig field ──────────────────
    let mut doc = Document::load_mem(pdf_bytes).map_err(|e| format!("pdf load: {e}"))?;

    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let first_page_id = *pages.first().ok_or("PDF has no pages")?;

    // Allocate two new object IDs.
    doc.max_id += 1;
    let sig_dict_id: ObjectId = (doc.max_id, 0);
    doc.max_id += 1;
    let sig_field_id: ObjectId = (doc.max_id, 0);

    fn lit(s: &str) -> Object {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    }

    // Signature dictionary — /Contents and /ByteRange are placeholders.
    let sig_dict = dictionary! {
        "Type"      => Object::Name(b"Sig".to_vec()),
        "Filter"    => Object::Name(b"Adobe.PPKLite".to_vec()),
        "SubFilter" => Object::Name(b"adbe.pkcs7.detached".to_vec()),
        // Large placeholder values so patch_byte_range has enough room for real
        // offsets (lopdf serialises integers as-is; "9999999999" = 10 digits each).
        "ByteRange" => Object::Array(vec![
            Object::Integer(9_999_999_999),
            Object::Integer(9_999_999_999),
            Object::Integer(9_999_999_999),
            Object::Integer(9_999_999_999),
        ]),
        "Contents"  => Object::String(
            vec![0u8; CONTENTS_PLACEHOLDER_LEN],
            StringFormat::Hexadecimal,
        ),
        "Reason"    => lit(opts.reason.as_deref().unwrap_or("Approved")),
        "Location"  => lit(opts.location.as_deref().unwrap_or("")),
        "Name"      => lit(opts.signer_name.as_deref().unwrap_or("")),
    };
    doc.objects.insert(sig_dict_id, Object::Dictionary(sig_dict));

    // Invisible widget annotation for the sig field.
    let widget = dictionary! {
        "Type"    => Object::Name(b"Annot".to_vec()),
        "Subtype" => Object::Name(b"Widget".to_vec()),
        "FT"      => Object::Name(b"Sig".to_vec()),
        "Rect"    => Object::Array(vec![
            Object::Integer(0), Object::Integer(0),
            Object::Integer(0), Object::Integer(0),
        ]),
        "V" => Object::Reference(sig_dict_id),
        "T" => lit("Signature1"),
        "F" => Object::Integer(132), // Print | Hidden
        "P" => Object::Reference(first_page_id),
    };
    doc.objects.insert(sig_field_id, Object::Dictionary(widget));

    // Add widget to first page's /Annots array.
    if let Ok(Object::Dictionary(page)) = doc.get_object_mut(first_page_id) {
        match page.get_mut(b"Annots") {
            Ok(Object::Array(arr)) => arr.push(Object::Reference(sig_field_id)),
            _ => page.set(
                b"Annots",
                Object::Array(vec![Object::Reference(sig_field_id)]),
            ),
        }
    }

    // Add /AcroForm to the catalog.
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .ok_or("no /Root in trailer")?;

    if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(catalog_id) {
        cat.set(
            b"AcroForm",
            Object::Dictionary(dictionary! {
                "Fields"   => Object::Array(vec![Object::Reference(sig_field_id)]),
                "SigFlags" => Object::Integer(3),
            }),
        );
    }

    // ── Step 2: serialise to bytes ───────────────────────────────────────────
    let mut staging: Vec<u8> = Vec::new();
    doc.save_to(&mut staging)
        .map_err(|e| format!("pdf save: {e}"))?;

    // ── Step 3: locate /ByteRange and /Contents offsets ──────────────────────
    let (byte_range_offset, contents_open_angle, contents_hex_len) =
        locate_sig_placeholders(&staging)?;

    let contents_hex_start = contents_open_angle + 1; // skip '<'
    let contents_hex_end = contents_hex_start + contents_hex_len;

    // Byte ranges: everything except the hex inside <…>.
    let br = [
        0usize,
        contents_open_angle,        // bytes before '<'
        contents_hex_end + 1,       // offset of byte after '>'
        staging.len() - (contents_hex_end + 1),
    ];

    patch_byte_range(&mut staging, byte_range_offset, br)?;

    // ── Step 4: hash the two byte ranges ────────────────────────────────────
    let mut hasher = Sha256::new();
    hasher.update(&staging[br[0]..br[0] + br[1]]);
    hasher.update(&staging[br[2]..br[2] + br[3]]);
    let digest = hasher.finalize();

    // ── Step 5: sign via provided signer (PKCS#11 in production, closure in tests) ──
    let raw_sig = signer(&digest)?;

    // ── Step 6: build CMS SignedData ─────────────────────────────────────────
    let cms_der = build_cms_signed_data(&opts.cert_der, &raw_sig)?;

    if cms_der.len() > CONTENTS_PLACEHOLDER_LEN {
        return Err(format!(
            "CMS blob ({} B) exceeds placeholder ({CONTENTS_PLACEHOLDER_LEN} B)",
            cms_der.len()
        ));
    }

    // ── Step 7: hex-encode CMS and splice into /Contents ─────────────────────
    let mut hex_cms = hex::encode(&cms_der);
    // Right-pad with zeros to fill the reserved space exactly.
    hex_cms.extend(std::iter::repeat('0').take(contents_hex_len - hex_cms.len()));
    staging[contents_hex_start..contents_hex_start + contents_hex_len]
        .copy_from_slice(hex_cms.as_bytes());

    Ok(staging)
}

/// Find the last `/ByteRange` and `/Contents <hex>` in the serialised bytes.
/// Returns (byterange_offset, offset_of_open_angle, hex_content_len).
fn locate_sig_placeholders(buf: &[u8]) -> Result<(usize, usize, usize), String> {
    let br_off = rfind(buf, b"/ByteRange")
        .ok_or("/ByteRange not found in serialised PDF")?;
    let ct_off = rfind(buf, b"/Contents")
        .ok_or("/Contents not found in serialised PDF")?;

    let mut i = ct_off + b"/Contents".len();
    while i < buf.len() && matches!(buf[i], b' ' | b'\n' | b'\r' | b'\t') {
        i += 1;
    }
    if buf.get(i) != Some(&b'<') {
        return Err(format!(
            "/Contents is not a hex string (byte 0x{:02x} at {i})",
            buf[i]
        ));
    }
    let hex_start = i + 1;
    let hex_end = buf[hex_start..]
        .iter()
        .position(|&b| b == b'>')
        .map(|p| hex_start + p)
        .ok_or("/Contents hex string not terminated")?;

    Ok((br_off, i, hex_end - hex_start))
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// Patch `/ByteRange [0 0 0 0]` in-place with real offsets.
fn patch_byte_range(buf: &mut [u8], offset: usize, br: [usize; 4]) -> Result<(), String> {
    let start = offset + b"/ByteRange".len();
    let arr_start = buf[start..]
        .iter()
        .position(|&b| b == b'[')
        .map(|p| start + p + 1)
        .ok_or("ByteRange '[' not found")?;
    let arr_end = buf[arr_start..]
        .iter()
        .position(|&b| b == b']')
        .map(|p| arr_start + p)
        .ok_or("ByteRange ']' not found")?;

    let new_value = format!("{} {} {} {}", br[0], br[1], br[2], br[3]);
    let old_len = arr_end - arr_start;
    if new_value.len() > old_len {
        return Err(format!(
            "ByteRange patch ({} chars) longer than placeholder ({old_len} chars)",
            new_value.len()
        ));
    }
    let patch = format!("{new_value:<old_len$}");
    buf[arr_start..arr_end].copy_from_slice(patch.as_bytes());
    Ok(())
}

/// Minimal CMS SignedData for adbe.pkcs7.detached (SHA-256, RSA or ECDSA).
/// No signed attributes — Phase 4 will add them along with timestamping.
fn build_cms_signed_data(cert_der: &[u8], raw_sig: &[u8]) -> Result<Vec<u8>, String> {
    // OIDs as full DER TLV (tag 0x06 + length + value).
    const OID_SIGNED_DATA: &[u8] = &[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
    ];
    const OID_DATA: &[u8] = &[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01,
    ];
    // SHA-256: 2.16.840.1.101.3.4.2.1
    const OID_SHA256: &[u8] = &[
        0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
    ];
    // rsaEncryption: 1.2.840.113549.1.1.1
    const OID_RSA: &[u8] = &[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    ];

    let cert = Certificate::from_der(cert_der).map_err(|e| e.to_string())?;
    let issuer_der = cert.tbs_certificate.issuer.to_der().map_err(|e| e.to_string())?;
    let serial_der = cert
        .tbs_certificate
        .serial_number
        .to_der()
        .map_err(|e| e.to_string())?;

    let sha256_alg_id = der_sequence(&[OID_SHA256, &[0x05, 0x00]]);

    // IssuerAndSerialNumber SEQUENCE { issuer Name, serialNumber INTEGER }
    let issuer_and_serial = der_sequence(&[&issuer_der, &serial_der]);

    // SignerInfo (version 1, no signed attributes for Phase 2)
    let signer_info = der_sequence(&[
        &[0x02, 0x01, 0x01], // version INTEGER 1
        &issuer_and_serial,
        &sha256_alg_id,
        &der_sequence(&[OID_RSA, &[0x05, 0x00]]), // signatureAlgorithm
        &der_octet_string(raw_sig),                // signature
    ]);

    // certificates [0] IMPLICIT — single cert, raw DER wrapped in context tag
    let certificates = der_context_constructed(0, cert_der);

    // SignedData SEQUENCE
    let signed_data = der_sequence(&[
        &[0x02, 0x01, 0x01],                    // version 1
        &der_set(&[&sha256_alg_id]),             // digestAlgorithms
        &der_sequence(&[OID_DATA]),              // encapContentInfo
        &certificates,                           // [0] certificates
        &der_set(&[&signer_info]),               // signerInfos
    ]);

    // ContentInfo SEQUENCE { contentType OID, content [0] EXPLICIT ANY }
    Ok(der_sequence(&[
        OID_SIGNED_DATA,
        &der_context_constructed(0, &signed_data),
    ]))
}

// ── Minimal DER helpers ──────────────────────────────────────────────────────

fn der_len(n: usize) -> Vec<u8> {
    if n < 128 {
        vec![n as u8]
    } else if n < 256 {
        vec![0x81, n as u8]
    } else {
        vec![0x82, (n >> 8) as u8, (n & 0xff) as u8]
    }
}

fn der_tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend_from_slice(&der_len(value.len()));
    out.extend_from_slice(value);
    out
}

fn der_sequence(parts: &[&[u8]]) -> Vec<u8> {
    let inner: Vec<u8> = parts.iter().flat_map(|p| p.iter().copied()).collect();
    der_tlv(0x30, &inner)
}

fn der_set(parts: &[&[u8]]) -> Vec<u8> {
    let inner: Vec<u8> = parts.iter().flat_map(|p| p.iter().copied()).collect();
    der_tlv(0x31, &inner)
}

fn der_octet_string(data: &[u8]) -> Vec<u8> {
    der_tlv(0x04, data)
}

fn der_context_constructed(tag: u8, value: &[u8]) -> Vec<u8> {
    der_tlv(0xa0 | tag, value)
}

// ── Tests ────────────────────────────────────────────────────────────────────


// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Document;
    use p256::ecdsa::{signature::Signer, SigningKey};
    use rand_core::OsRng;
    use x509_cert::{
        builder::{Builder, CertificateBuilder, Profile},
        name::Name,
        serial_number::SerialNumber,
        time::Validity,
    };

    // ── DER helper tests ─────────────────────────────────────────────────────

    #[test]
    fn test_der_len_short() {
        assert_eq!(der_len(0), vec![0x00]);
        assert_eq!(der_len(127), vec![0x7f]);
    }

    #[test]
    fn test_der_len_one_byte_long() {
        assert_eq!(der_len(128), vec![0x81, 0x80]);
        assert_eq!(der_len(255), vec![0x81, 0xff]);
    }

    #[test]
    fn test_der_len_two_byte_long() {
        assert_eq!(der_len(256), vec![0x82, 0x01, 0x00]);
        assert_eq!(der_len(0x1234), vec![0x82, 0x12, 0x34]);
    }

    #[test]
    fn test_der_sequence_empty() {
        assert_eq!(der_sequence(&[]), vec![0x30, 0x00]);
    }

    #[test]
    fn test_der_sequence_nested() {
        let inner = der_sequence(&[]);
        let outer = der_sequence(&[&inner]);
        // SEQUENCE { SEQUENCE {} } = 30 02 30 00
        assert_eq!(outer, vec![0x30, 0x02, 0x30, 0x00]);
    }

    #[test]
    fn test_der_set_single() {
        let item = vec![0x02, 0x01, 0x01]; // INTEGER 1
        let set = der_set(&[&item]);
        assert_eq!(set, vec![0x31, 0x03, 0x02, 0x01, 0x01]);
    }

    #[test]
    fn test_der_octet_string() {
        let os = der_octet_string(&[0xde, 0xad]);
        assert_eq!(os, vec![0x04, 0x02, 0xde, 0xad]);
    }

    // ── ByteRange helpers ────────────────────────────────────────────────────

    #[test]
    fn test_patch_byte_range_basic() {
        let mut buf = b"/ByteRange [000000000000000000000000000000]".to_vec();
        patch_byte_range(&mut buf, 0, [0, 100, 200, 300]).unwrap();
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("0 100 200 300"), "patched: {s}");
    }

    #[test]
    fn test_patch_byte_range_too_small_errors() {
        let mut buf = b"/ByteRange [0000]".to_vec();
        let err = patch_byte_range(&mut buf, 0, [0, 100000, 200000, 300000]).unwrap_err();
        assert!(err.contains("longer than placeholder"), "{err}");
    }

    #[test]
    fn test_locate_placeholders_roundtrip() {
        let hex = "00".repeat(32);
        let buf = format!("/ByteRange [0 0 0 0] /Contents <{hex}>").into_bytes();
        let (br_off, open_angle, hex_len) = locate_sig_placeholders(&buf).unwrap();
        assert_eq!(hex_len, 64);
        assert_eq!(buf[open_angle], b'<');
        assert!(br_off < open_angle);
    }

    // ── Full signing pipeline ────────────────────────────────────────────────

    fn next_id(doc: &mut Document) -> ObjectId {
        doc.max_id += 1;
        (doc.max_id, 0)
    }

    /// Minimal valid single-page PDF built entirely in memory.
    fn minimal_pdf() -> Vec<u8> {
        let mut doc = Document::new();
        let pages_id = next_id(&mut doc);
        let page_id = next_id(&mut doc);
        let catalog_id = next_id(&mut doc);

        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type"  => Object::Name(b"Pages".to_vec()),
                "Kids"  => Object::Array(vec![Object::Reference(page_id)]),
                "Count" => Object::Integer(1),
            }),
        );
        doc.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type"     => Object::Name(b"Page".to_vec()),
                "Parent"   => Object::Reference(pages_id),
                "MediaBox" => Object::Array(vec![
                    Object::Integer(0), Object::Integer(0),
                    Object::Integer(612), Object::Integer(792),
                ]),
            }),
        );
        doc.objects.insert(
            catalog_id,
            Object::Dictionary(dictionary! {
                "Type"  => Object::Name(b"Catalog".to_vec()),
                "Pages" => Object::Reference(pages_id),
            }),
        );
        doc.trailer.set("Root", Object::Reference(catalog_id));

        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("save minimal PDF");
        bytes
    }

    /// Generate an in-memory P-256 signing key + self-signed DER certificate.
    fn test_key_and_cert() -> (SigningKey, Vec<u8>) {
        use der::Encode;
        use x509_cert::spki::EncodePublicKey;

        let signing_key = SigningKey::random(&mut OsRng);
        let verifying_key = signing_key.verifying_key();

        // Build a self-signed cert using x509-cert builder.
        let subject: Name = "CN=pdfsign test,O=pdfsign dev,C=DE".parse().unwrap();
        let validity = Validity::from_now(std::time::Duration::from_secs(365 * 86400)).unwrap();
        let serial = SerialNumber::from(42u32);

        let pub_key = p256::PublicKey::from(verifying_key);
        let spki = pub_key.to_public_key_der().unwrap();

        let mut builder = CertificateBuilder::new(
            Profile::Leaf {
                issuer: subject.clone(),
                enable_key_agreement: false,
                enable_key_encipherment: false,
            },
            serial,
            validity,
            subject,
            spki.decode_msg::<x509_cert::spki::SubjectPublicKeyInfoOwned>().unwrap(),
            &signing_key,
        )
        .unwrap();

        let cert = builder.build::<p256::ecdsa::DerSignature>().unwrap();
        let cert_der = cert.to_der().unwrap();
        (signing_key, cert_der)
    }

    #[test]
    fn test_full_pipeline_produces_valid_pdf_structure() {
        let pdf_bytes = minimal_pdf();
        let (signing_key, cert_der) = test_key_and_cert();

        let opts = SignOptions {
            slot_id: 0,
            cert_der: cert_der.clone(),
            pin: "unused".into(),
            reason: Some("Testing".into()),
            location: None,
            signer_name: Some("Test Signer".into()),
            ts_url: None,
        };

        let signed = do_sign_with(&pdf_bytes, &opts, |digest| {
            let sig: p256::ecdsa::DerSignature = signing_key.sign(digest);
            Ok(sig.as_bytes().to_vec())
        })
        .expect("signing pipeline should succeed");

        // Must parse as a valid PDF.
        let doc = Document::load_mem(&signed).expect("signed PDF must be parseable");

        // Must have a /Sig dict with the expected /SubFilter.
        let has_sig = doc.objects.values().any(|obj| {
            if let Object::Dictionary(d) = obj {
                d.get(b"SubFilter").ok().and_then(|o| o.as_name().ok())
                    == Some(b"adbe.pkcs7.detached")
            } else {
                false
            }
        });
        assert!(has_sig, "signed PDF must contain adbe.pkcs7.detached sig dict");

        // /Contents must have been replaced (not all zeros).
        let contents_still_zero = doc.objects.values().any(|obj| {
            if let Object::Dictionary(d) = obj {
                if let Ok(Object::String(bytes, _)) = d.get(b"Contents") {
                    return bytes.iter().all(|&b| b == 0);
                }
            }
            false
        });
        assert!(!contents_still_zero, "/Contents must hold the CMS, not all zeros");
    }

    #[test]
    fn test_cms_output_is_valid_der() {
        let (signing_key, cert_der) = test_key_and_cert();
        let dummy_sig: p256::ecdsa::DerSignature = signing_key.sign(b"test digest");
        let cms = build_cms_signed_data(&cert_der, dummy_sig.as_bytes()).unwrap();

        // Must start with SEQUENCE tag.
        assert_eq!(cms[0], 0x30, "CMS ContentInfo must start with SEQUENCE (0x30)");

        // DER length field must be consistent with actual byte count.
        let (declared_len, header_len) = if cms[1] < 0x80 {
            (cms[1] as usize, 2)
        } else if cms[1] == 0x81 {
            (cms[2] as usize, 3)
        } else {
            (((cms[2] as usize) << 8) | cms[3] as usize, 4)
        };
        assert_eq!(
            cms.len(),
            declared_len + header_len,
            "DER length field must match actual byte count"
        );
    }
}

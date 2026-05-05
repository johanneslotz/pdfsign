use der::{asn1::OctetString, Encode};
use lopdf::{Document, Object, ObjectId, Stream};
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
    // ── Step 1: parse existing PDF and append a /Sig field ──────────────────
    let mut doc = Document::load_mem(pdf_bytes).map_err(|e| format!("pdf load: {e}"))?;

    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let first_page_id = *pages.first().ok_or("PDF has no pages")?;

    // Allocate object IDs for the sig field and the sig dictionary.
    let sig_dict_id = doc.new_object_id();
    let sig_field_id = doc.new_object_id();

    // Signature dictionary — /Contents and /ByteRange are placeholders.
    let hex_placeholder = "0".repeat(CONTENTS_PLACEHOLDER_LEN * 2);
    let sig_dict = lopdf::dictionary! {
        "Type"        => Object::Name(b"Sig".to_vec()),
        "Filter"      => Object::Name(b"Adobe.PPKLite".to_vec()),
        "SubFilter"   => Object::Name(b"adbe.pkcs7.detached".to_vec()),
        "ByteRange"   => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(0),
        ]),
        "Contents"    => Object::String(
            vec![0u8; CONTENTS_PLACEHOLDER_LEN],
            lopdf::StringFormat::Hexadecimal,
        ),
        "Reason"      => Object::string_literal(
            opts.reason.as_deref().unwrap_or("Approved")
        ),
        "Location"    => Object::string_literal(
            opts.location.as_deref().unwrap_or("")
        ),
        "Name"        => Object::string_literal(
            opts.signer_name.as_deref().unwrap_or("")
        ),
    };
    doc.objects
        .insert(sig_dict_id, Object::Dictionary(sig_dict));

    // Widget annotation for the sig field (invisible, 0×0 rect).
    let widget = lopdf::dictionary! {
        "Type"    => Object::Name(b"Annot".to_vec()),
        "Subtype" => Object::Name(b"Widget".to_vec()),
        "FT"      => Object::Name(b"Sig".to_vec()),
        "Rect"    => Object::Array(vec![
            Object::Integer(0), Object::Integer(0),
            Object::Integer(0), Object::Integer(0),
        ]),
        "V"       => Object::Reference(sig_dict_id),
        "T"       => Object::string_literal("Signature1"),
        "F"       => Object::Integer(132), // Print | Hidden
        "P"       => Object::Reference(first_page_id),
    };
    doc.objects.insert(sig_field_id, Object::Dictionary(widget));

    // Add widget to first page's /Annots array.
    if let Ok(page) = doc.get_object_mut(first_page_id) {
        if let Object::Dictionary(d) = page {
            let annots = d.get_mut(b"Annots").and_then(|o| {
                if let Object::Array(a) = o {
                    Some(a)
                } else {
                    None
                }
            });
            if let Some(arr) = annots {
                arr.push(Object::Reference(sig_field_id));
            } else {
                d.set(
                    b"Annots",
                    Object::Array(vec![Object::Reference(sig_field_id)]),
                );
            }
        }
    }

    // Add /AcroForm to the catalog.
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .and_then(|o| o.as_reference().ok())
        .ok_or("no /Root in trailer")?;

    if let Ok(Object::Dictionary(cat)) = doc.get_object_mut(catalog_id) {
        cat.set(
            b"AcroForm",
            Object::Dictionary(lopdf::dictionary! {
                "Fields"   => Object::Array(vec![Object::Reference(sig_field_id)]),
                "SigFlags" => Object::Integer(3),
            }),
        );
    }

    // ── Step 2: serialise to bytes ───────────────────────────────────────────
    let mut staging: Vec<u8> = Vec::new();
    doc.save_to(&mut staging)
        .map_err(|e| format!("pdf save: {e}"))?;

    // ── Step 3: locate ByteRange and Contents in the serialised bytes ────────
    let (byte_range_offset, contents_offset, contents_hex_len) = locate_sig_placeholders(&staging)?;

    // The signed byte ranges are everything except the hex-encoded Contents value.
    // Contents in PDF is written as < hex... > so the hex starts at contents_offset+1
    // and ends CONTENTS_PLACEHOLDER_LEN*2 bytes later.
    let contents_hex_start = contents_offset + 1; // skip the '<'
    let contents_hex_end = contents_hex_start + contents_hex_len;

    let br = [
        0usize,
        contents_hex_start - 1, // up to (but not including) the '<'
        contents_hex_end + 1,   // after the '>'
        staging.len() - (contents_hex_end + 1),
    ];

    // Patch the ByteRange array in-place.
    patch_byte_range(&mut staging, byte_range_offset, br)?;

    // ── Step 4: hash the two byte ranges ────────────────────────────────────
    let mut hasher = Sha256::new();
    hasher.update(&staging[br[0]..br[0] + br[1]]);
    hasher.update(&staging[br[2]..br[2] + br[3]]);
    let digest = hasher.finalize();

    // ── Step 5: sign via PKCS#11 ─────────────────────────────────────────────
    let raw_sig = pkcs11_sign(&opts.cert_der, opts.slot_id, &digest, &opts.pin)?;

    // ── Step 6: build CMS SignedData ─────────────────────────────────────────
    let cms_der = build_cms_signed_data(&opts.cert_der, &digest, &raw_sig, opts.ts_url.as_deref())?;

    if cms_der.len() > CONTENTS_PLACEHOLDER_LEN {
        return Err(format!(
            "CMS blob ({} bytes) exceeds placeholder ({CONTENTS_PLACEHOLDER_LEN} bytes); \
             increase CONTENTS_PLACEHOLDER_LEN",
            cms_der.len()
        ));
    }

    // ── Step 7: hex-encode CMS and splice into Contents ──────────────────────
    let mut hex_cms = hex::encode(&cms_der);
    // Pad with zeros to fill the reserved space exactly.
    hex_cms.extend(std::iter::repeat('0').take(contents_hex_len - hex_cms.len()));

    let hex_bytes = hex_cms.as_bytes();
    staging[contents_hex_start..contents_hex_start + contents_hex_len].copy_from_slice(hex_bytes);

    Ok(staging)
}

/// Returns (byte_range_array_offset, contents_hex_offset, contents_hex_len).
fn locate_sig_placeholders(buf: &[u8]) -> Result<(usize, usize, usize), String> {
    // We look for the last occurrence of "/ByteRange" and "/Contents" because
    // there may be multiple signature fields in incremental updates.
    let br_needle = b"/ByteRange";
    let ct_needle = b"/Contents";

    let br_off = rfind(buf, br_needle).ok_or("/ByteRange not found in serialised PDF")?;
    let ct_off = rfind(buf, ct_needle).ok_or("/Contents not found in serialised PDF")?;

    // After /Contents we expect whitespace then '<' then hex then '>'.
    let mut i = ct_off + ct_needle.len();
    while i < buf.len() && (buf[i] == b' ' || buf[i] == b'\n' || buf[i] == b'\r') {
        i += 1;
    }
    if buf[i] != b'<' {
        return Err(format!(
            "/Contents value is not a hex string (found {:?} at offset {i})",
            buf[i] as char
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

/// Overwrite the `/ByteRange [0 0 0 0]` placeholder with real offsets.
fn patch_byte_range(buf: &mut [u8], offset: usize, br: [usize; 4]) -> Result<(), String> {
    // Find the '[' after /ByteRange.
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
            "ByteRange patch value ({}) longer than placeholder ({})",
            new_value.len(),
            old_len
        ));
    }
    // Write the new value left-justified and pad the rest with spaces.
    let patch = format!("{:<width$}", new_value, width = old_len);
    buf[arr_start..arr_end].copy_from_slice(patch.as_bytes());
    Ok(())
}

/// Minimal CMS SignedData (adbe.pkcs7.detached, SHA-256).
///
/// We hand-build the DER rather than pulling in a full ASN.1 framework so
/// the dependency surface stays small.  For Phase 2 this is sufficient;
/// Phase 4 will extend it with signed attributes, timestamping, and LTV.
fn build_cms_signed_data(
    cert_der: &[u8],
    digest: &[u8],
    raw_sig: &[u8],
    _ts_url: Option<&str>,
) -> Result<Vec<u8>, String> {
    // OIDs (DER-encoded without the tag/length wrapper used in context).
    const OID_SIGNED_DATA: &[u8] = &[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
    ];
    const OID_DATA: &[u8] = &[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01,
    ];
    const OID_SHA256: &[u8] = &[
        0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x86, 0xf8, 0x45, 0x01, 0x65,
        0x03,
        // Actually SHA-256 OID is 2.16.840.1.101.3.4.2.1
        // = 0x06 0x09 0x60 0x86 0x48 0x01 0x65 0x03 0x04 0x02 0x01
    ];
    // Correct SHA-256 OID: 2.16.840.1.101.3.4.2.1
    const OID_SHA256_CORRECT: &[u8] = &[
        0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
    ];
    // rsaEncryption OID: 1.2.840.113549.1.1.1
    const OID_RSA: &[u8] = &[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    ];

    let cert = Certificate::from_der(cert_der).map_err(|e| e.to_string())?;
    let issuer_der = cert
        .tbs_certificate
        .issuer
        .to_der()
        .map_err(|e| e.to_string())?;
    let serial_der = cert
        .tbs_certificate
        .serial_number
        .to_der()
        .map_err(|e| e.to_string())?;

    // IssuerAndSerialNumber ::= SEQUENCE { issuer Name, serialNumber INTEGER }
    let issuer_and_serial = der_sequence(&[&issuer_der, &serial_der]);

    // DigestAlgorithmIdentifier (SHA-256, NULL params)
    let sha256_alg_id = der_sequence(&[OID_SHA256_CORRECT, &[0x05, 0x00]]);

    // SignerInfo
    let signer_info = der_sequence(&[
        &[0x02, 0x01, 0x01], // version = 1
        &issuer_and_serial,
        &sha256_alg_id,
        // signatureAlgorithm: rsaEncryption NULL
        &der_sequence(&[OID_RSA, &[0x05, 0x00]]),
        // signature OCTET STRING
        &der_octet_string(raw_sig),
    ]);

    // DigestAlgorithms SET
    let digest_algorithms = der_set(&[&sha256_alg_id]);

    // EncapsulatedContentInfo (empty detached data)
    let encap_content_info = der_sequence(&[OID_DATA]);

    // Certificates [0] IMPLICIT
    let certificates = {
        let mut inner = cert_der.to_vec();
        der_tagged_implicit(0, &inner)
    };

    // SignedData SEQUENCE
    let signed_data = der_sequence(&[
        &[0x02, 0x01, 0x01], // version = 1
        &digest_algorithms,
        &encap_content_info,
        &certificates,
        &der_set(&[&signer_info]), // signerInfos SET
    ]);

    // ContentInfo SEQUENCE { OID signedData, [0] EXPLICIT SignedData }
    let content_info = der_sequence(&[OID_SIGNED_DATA, &der_tagged_explicit(0, &signed_data)]);

    Ok(content_info)
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

fn der_tagged_explicit(tag: u8, value: &[u8]) -> Vec<u8> {
    der_tlv(0xa0 | tag, value)
}

fn der_tagged_implicit(tag: u8, value: &[u8]) -> Vec<u8> {
    der_tlv(0xa0 | tag, value)
}

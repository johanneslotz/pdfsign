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
        "ByteRange" => Object::Array(vec![
            Object::Integer(0), Object::Integer(0),
            Object::Integer(0), Object::Integer(0),
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

    // ── Step 5: sign via PKCS#11 ────────────────────────────────────────────
    let raw_sig = pkcs11_sign(&opts.cert_der, opts.slot_id, &digest, &opts.pin)?;

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

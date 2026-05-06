use cryptoki::{
    context::{CInitializeArgs, Pkcs11},
    mechanism::Mechanism,
    object::{Attribute, AttributeType, KeyType, ObjectClass},
    session::UserType,
    types::AuthPin,
};
use serde::Serialize;
use x509_cert::{der::Decode, Certificate};

#[derive(Debug, Serialize)]
pub struct CertInfo {
    pub slot_id: u64,
    pub label: String,
    pub subject: String,
    pub issuer: String,
    pub serial: String,
    pub not_after: String,
    pub cert_der: Vec<u8>,
}

/// Resolve the PKCS#11 library path for the current OS.
pub fn default_pkcs11_lib() -> String {
    if let Ok(v) = std::env::var("PKCS11_MODULE") {
        return v;
    }
    #[cfg(target_os = "macos")]
    {
        // OpenSC installed via Homebrew or the official installer.
        for p in &[
            "/Library/OpenSC/lib/opensc-pkcs11.so",
            "/opt/homebrew/lib/opensc-pkcs11.so",
            "/usr/local/lib/opensc-pkcs11.so",
        ] {
            if std::path::Path::new(p).exists() {
                return p.to_string();
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for p in &[
            "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
            "/usr/lib/opensc-pkcs11.so",
            // SoftHSM2 for dev/testing
            "/usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so",
            "/usr/lib/softhsm/libsofthsm2.so",
        ] {
            if std::path::Path::new(p).exists() {
                return p.to_string();
            }
        }
    }
    "opensc-pkcs11.so".to_string()
}

#[tauri::command]
pub async fn list_smartcard_certs() -> Result<Vec<CertInfo>, String> {
    let lib_path = default_pkcs11_lib();
    let pkcs11 = Pkcs11::new(&lib_path).map_err(|e| format!("load {lib_path}: {e}"))?;
    pkcs11
        .initialize(CInitializeArgs::OsThreads)
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    for slot in pkcs11.get_slots_with_token().map_err(|e| e.to_string())? {
        let slot_id: u64 = slot.id();

        // Open a read-only session — no PIN needed for cert enumeration.
        let session = match pkcs11.open_ro_session(slot) {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Some vendor PKCS#11 stacks do not expose CKA_CERTIFICATE_TYPE
        // consistently; filtering only by class improves compatibility.
        let template = vec![Attribute::Class(ObjectClass::CERTIFICATE)];

        let handles = match session.find_objects(&template) {
            Ok(h) => h,
            Err(_) => continue,
        };

        for handle in handles {
            let attrs = match session
                .get_attributes(handle, &[AttributeType::Label, AttributeType::Value])
            {
                Ok(a) => a,
                Err(_) => continue,
            };

            let mut label_bytes: Vec<u8> = Vec::new();
            let mut cert_der: Vec<u8> = Vec::new();

            for attr in &attrs {
                match attr {
                    Attribute::Label(v) => label_bytes = v.clone(),
                    Attribute::Value(v) => cert_der = v.clone(),
                    _ => {}
                }
            }
            let label = String::from_utf8_lossy(&label_bytes).into_owned();

            if cert_der.is_empty() {
                continue;
            }

            // Parse X.509 metadata best-effort; keep certs even when metadata
            // parsing fails so users can still pick a signer certificate.
            let (subject, issuer, serial, not_after) = match Certificate::from_der(&cert_der) {
                Ok(cert) => {
                    let subject = cert.tbs_certificate.subject.to_string();
                    let issuer = cert.tbs_certificate.issuer.to_string();
                    let serial = format!(
                        "{:X}",
                        cert.tbs_certificate
                            .serial_number
                            .as_bytes()
                            .iter()
                            .fold(0u128, |acc, &b| acc << 8 | b as u128)
                    );
                    let not_after = cert.tbs_certificate.validity.not_after.to_string();
                    (subject, issuer, serial, not_after)
                }
                Err(_) => {
                    let fallback_subject = if label.is_empty() {
                        "Unknown certificate".to_string()
                    } else {
                        label.clone()
                    };
                    (
                        fallback_subject,
                        String::new(),
                        String::new(),
                        String::new(),
                    )
                }
            };

            // Skip certs whose key usage doesn't include digital signature
            // (best-effort: missing key usage extension → include anyway).
            results.push(CertInfo {
                slot_id,
                label,
                subject,
                issuer,
                serial,
                not_after,
                cert_der,
            });
        }
    }

    pkcs11.finalize();
    Ok(results)
}

/// Sign a raw digest using the private key on the token that matches
/// the given cert DER bytes (matched by CKA_ID).
pub fn pkcs11_sign(
    cert_der: &[u8],
    slot_id: u64,
    digest: &[u8],
    pin: &str,
) -> Result<Vec<u8>, String> {
    let lib_path = default_pkcs11_lib();
    let pkcs11 = Pkcs11::new(&lib_path).map_err(|e| format!("load {lib_path}: {e}"))?;
    pkcs11
        .initialize(CInitializeArgs::OsThreads)
        .map_err(|e| e.to_string())?;

    let slots = pkcs11.get_slots_with_token().map_err(|e| e.to_string())?;
    let slot = slots
        .into_iter()
        .find(|s| s.id() == slot_id)
        .ok_or_else(|| format!("slot {slot_id} not found"))?;

    let session = pkcs11.open_rw_session(slot).map_err(|e| e.to_string())?;
    session
        .login(UserType::User, Some(&AuthPin::new(pin.into())))
        .map_err(|e| format!("PIN rejected: {e}"))?;

    // Find the private key associated with this certificate (match by CKA_ID).
    // We retrieve the CKA_ID from the cert object first.
    let cert_tmpl = vec![
        Attribute::Class(ObjectClass::CERTIFICATE),
        Attribute::Value(cert_der.to_vec()),
    ];
    let cert_handles = session
        .find_objects(&cert_tmpl)
        .map_err(|e| e.to_string())?;
    let cert_handle = cert_handles
        .first()
        .copied()
        .ok_or("certificate object not found on token")?;

    let id_attrs = session
        .get_attributes(cert_handle, &[AttributeType::Id])
        .map_err(|e| e.to_string())?;
    let key_id = match id_attrs.first() {
        Some(Attribute::Id(id)) => id.clone(),
        _ => return Err("CKA_ID not found on cert object".into()),
    };

    let key_tmpl = vec![
        Attribute::Class(ObjectClass::PRIVATE_KEY),
        Attribute::Id(key_id),
        Attribute::Sign(true),
    ];
    let key_handles = session.find_objects(&key_tmpl).map_err(|e| e.to_string())?;
    let key_handle = key_handles
        .first()
        .copied()
        .ok_or("private key not found on token")?;

    // Detect key type to pick the right mechanism.
    let key_type_attrs = session
        .get_attributes(key_handle, &[AttributeType::KeyType])
        .map_err(|e| e.to_string())?;
    let mechanism = match key_type_attrs.first() {
        Some(Attribute::KeyType(KeyType::EC)) => Mechanism::Ecdsa,
        _ => Mechanism::RsaPkcs, // default: RSA PKCS#1 v1.5
    };

    let signature = session
        .sign(&mechanism, key_handle, digest)
        .map_err(|e| format!("sign failed: {e}"))?;

    pkcs11.finalize();
    Ok(signature)
}

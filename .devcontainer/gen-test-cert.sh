#!/usr/bin/env bash
# Generate a self-signed RSA-2048 test certificate in the SoftHSM2 token.
# Run once after container creation to prepare the Phase-2 signing test.
set -euo pipefail

export SOFTHSM2_CONF="$HOME/.softhsm2/softhsm2.conf"
PIN="1234"
LABEL="pdfsign-test-key"
TMPDIR=$(mktemp -d)

LIB=$(softhsm2-util --show-slots 2>/dev/null | head -1 | grep -o '/.*softhsm.*\.so[^ ]*' || \
      find /usr -name "libsofthsm2.so" 2>/dev/null | head -1)

if [ -z "$LIB" ]; then
  # Common paths
  for p in /usr/lib/softhsm/libsofthsm2.so \
            /usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so; do
    [ -f "$p" ] && LIB="$p" && break
  done
fi

echo "Using PKCS#11 library: $LIB"

# Generate key pair on the token.
pkcs11-tool --module "$LIB" \
  --login --pin "$PIN" \
  --keypairgen --key-type rsa:2048 \
  --label "$LABEL" --id 01 \
  --usage-sign

# Export the public key, build a self-signed cert with openssl, import it.
pkcs11-tool --module "$LIB" \
  --login --pin "$PIN" \
  --read-object --type pubkey --label "$LABEL" \
  --output-file "$TMPDIR/pub.der"

openssl rsa -pubin -inform DER -in "$TMPDIR/pub.der" -out "$TMPDIR/pub.pem" 2>/dev/null || \
  openssl pkey -pubin -inform DER -in "$TMPDIR/pub.der" -out "$TMPDIR/pub.pem"

# Self-signed cert (365 days, signing + non-repudiation key usage).
openssl req -new -x509 -days 365 \
  -subj "/CN=pdfsign test/O=pdfsign dev/C=DE" \
  -key "$TMPDIR/pub.pem" -keyform PEM \
  -out "$TMPDIR/cert.pem" \
  -extensions v3_req \
  -config <(cat /etc/ssl/openssl.cnf; printf '[v3_req]\nkeyUsage=critical,digitalSignature,nonRepudiation\n') \
  2>/dev/null || \
openssl req -new -x509 -days 365 \
  -subj "/CN=pdfsign test/O=pdfsign dev/C=DE" \
  -newkey rsa:2048 -nodes \
  -keyout "$TMPDIR/key.pem" \
  -out "$TMPDIR/cert.pem"

openssl x509 -in "$TMPDIR/cert.pem" -out "$TMPDIR/cert.der" -outform DER

pkcs11-tool --module "$LIB" \
  --login --pin "$PIN" \
  --write-object "$TMPDIR/cert.der" --type cert \
  --label "$LABEL" --id 01

echo "Test key + certificate loaded into SoftHSM2 token 'pdfsign-test'."
echo "Verify with: pkcs11-tool --module $LIB --login --pin $PIN --list-objects"

rm -rf "$TMPDIR"

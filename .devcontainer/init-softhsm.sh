#!/usr/bin/env bash
# Initialise a SoftHSM2 token for Phase-2 PAdES testing.
# Safe to re-run: skips init if the token already exists.
set -euo pipefail

CONF="$HOME/.softhsm2/softhsm2.conf"
TOKENDIR="$HOME/.softhsm2/tokens"

mkdir -p "$TOKENDIR"

# Write a per-user config pointing at the local token directory.
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<EOF
directories.tokendir = $TOKENDIR
objectstore.backend = file
log.level = INFO
EOF
fi

export SOFTHSM2_CONF="$CONF"

# Check if the test token is already initialised.
if softhsm2-util --show-slots 2>/dev/null | grep -q "pdfsign-test"; then
  echo "SoftHSM2 token 'pdfsign-test' already exists — skipping init."
  exit 0
fi

softhsm2-util --init-token --free \
  --label "pdfsign-test" \
  --so-pin 0000 \
  --pin 1234

echo "SoftHSM2 token 'pdfsign-test' initialised (PIN: 1234, SO-PIN: 0000)."
echo "To generate a test key+cert later, run: .devcontainer/gen-test-cert.sh"

FROM mcr.microsoft.com/devcontainers/rust:1-bookworm

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && node --version && npm --version

# Tauri v2 Linux system dependencies + PKCS#11 + virtual display
RUN apt-get install -y \
        libwebkit2gtk-4.1-dev \
        libssl-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libxdo-dev \
        libpcsclite-dev \
        pcscd \
        opensc \
        softhsm2 \
        patchelf \
        file \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# Tauri CLI v2 (locked to avoid silent upgrades)
RUN cargo install tauri-cli --version "^2" --locked

# Pre-warm the Rust registry cache so first `cargo build` inside the
# container doesn't re-download everything from scratch.
RUN cargo search tauri --limit 1 > /dev/null 2>&1 || true

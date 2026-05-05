const { invoke } = window.__TAURI__.core;

export class TauriProvider {
  async listCerts() {
    return invoke('list_smartcard_certs');
  }

  async sign(pdfBytes, options) {
    const result = await invoke('sign_pdf', {
      pdfBytes: Array.from(pdfBytes),
      options,
    });
    return new Uint8Array(result.signed_pdf);
  }
}

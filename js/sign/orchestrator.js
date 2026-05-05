export const isTauri = () => Boolean(window.__TAURI__);

export async function listSmartcardCerts() {
  if (!isTauri()) throw new Error('not-in-app');
  const { TauriProvider } = await import('./tauri-provider.js');
  return new TauriProvider().listCerts();
}

export async function cryptoSign(pdfBytes, options) {
  if (!isTauri()) throw new Error('not-in-app');
  const { TauriProvider } = await import('./tauri-provider.js');
  return new TauriProvider().sign(pdfBytes, options);
}

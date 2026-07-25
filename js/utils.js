// Verbose [pdfsign]-tagged logging, off by default so normal usage doesn't
// spam the console. Enable with ?debug in the URL or localStorage.pdfsign_debug.
const DEBUG =
  new URLSearchParams(location.search).has('debug') ||
  localStorage.getItem('pdfsign_debug') === '1';

export function debugLog(...args) {
  if (DEBUG) console.log('[pdfsign]', ...args);
}

/**
 * Wires the two dismiss gestures every modal needs — clicking the backdrop
 * and pressing Escape — to a single close callback. Each modal keeps its own
 * close function for whatever else it needs to do (clearing a PIN field,
 * abandoning an in-progress import); this only covers the two triggers that
 * were otherwise hand-repeated per modal, and Escape wasn't wired up at all.
 */
export function bindModalDismiss(modalEl, onClose) {
  const backdrop = modalEl.querySelector('.modal-backdrop');
  if (backdrop) backdrop.onclick = onClose;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) onClose();
  });
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}

export function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

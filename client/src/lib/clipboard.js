import toast from '../components/ui/Toast';

// `navigator.clipboard` is undefined on insecure-origin contexts (raw HTTP over
// LAN, some embedded webviews). Each helper short-circuits cleanly so callers
// don't have to re-check `?.writeText` / `?.readText` at every site.

export async function writeClipboardSilently(text) {
  if (!text || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copyToClipboard(text, successMessage = 'Copied') {
  if (!text) return false;
  if (!navigator.clipboard?.writeText) {
    toast.error('Clipboard unavailable on insecure context');
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
    return true;
  } catch {
    toast.error('Copy failed');
    return false;
  }
}

export async function readClipboard() {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

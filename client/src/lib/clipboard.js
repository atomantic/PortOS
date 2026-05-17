import toast from '../components/ui/Toast';

// `navigator.clipboard` is undefined on insecure-origin contexts (raw HTTP over
// LAN, some embedded webviews). Reading via `globalThis.navigator` also keeps
// the helpers safe in non-browser contexts (unit tests, SSR), where a bare
// `navigator` reference would throw a ReferenceError before optional-chaining
// could help. Each helper short-circuits cleanly so callers don't have to
// re-check `?.writeText` / `?.readText` at every site.

const clipboard = () => globalThis.navigator?.clipboard;

export async function writeClipboardSilently(text) {
  const c = clipboard();
  if (!text || !c?.writeText) return false;
  try {
    await c.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Pass `successMessage: null` to keep the failure/insecure-context toasts but
// suppress the success toast — for callers that own a transient "Copied"
// indicator in their own UI.
export async function copyToClipboard(text, successMessage = 'Copied') {
  if (!text) return false;
  const c = clipboard();
  if (!c?.writeText) {
    toast.error('Clipboard unavailable on insecure context');
    return false;
  }
  try {
    await c.writeText(text);
    if (successMessage) toast.success(successMessage);
    return true;
  } catch {
    toast.error('Copy failed');
    return false;
  }
}

export async function readClipboard() {
  const c = clipboard();
  if (!c?.readText) return null;
  try {
    return await c.readText();
  } catch {
    return null;
  }
}

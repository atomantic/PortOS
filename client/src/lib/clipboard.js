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
    // `navigator.clipboard` can be missing on insecure origins *or* on secure
    // origins where the API is disabled (unsupported browser, Permissions
    // Policy, etc.). Only call out the insecure-context case when we can
    // confirm it — otherwise stay generic so the message isn't misleading.
    const insecure = globalThis.isSecureContext === false;
    toast.error(insecure ? 'Clipboard unavailable on insecure context' : 'Clipboard unavailable');
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

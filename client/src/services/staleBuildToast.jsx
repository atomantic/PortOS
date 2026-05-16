import toast from '../components/ui/Toast';

/**
 * Sticky toast shown when the server's build id no longer matches the build
 * id the current tab was served with. Manual reload — we don't auto-refresh
 * because the user might be mid-typing in a form.
 */
export function showStaleBuildToast() {
  toast(
    <div className="flex items-center gap-3">
      <span>New build available.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-2 py-1 rounded bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
      >
        Reload
      </button>
    </div>,
    { id: 'portos-stale-build', duration: Infinity },
  );
}

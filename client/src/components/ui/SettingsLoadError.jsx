import Banner from './Banner';

// Inline load-failure state for settings panels: callers also disable Save so
// default values shown after a failed read are never written over stored ones.
export default function SettingsLoadError({ onRetry, children = 'Failed to load saved settings. The values shown are not your saved configuration.' }) {
  return (
    <Banner
      tone="error"
      size="sm"
      actions={
        <button
          type="button"
          onClick={onRetry}
          className="px-2.5 py-1 text-xs font-medium bg-port-error/20 hover:bg-port-error/30 text-port-error rounded transition-colors"
        >
          Retry
        </button>
      }
    >
      {children}
    </Banner>
  );
}

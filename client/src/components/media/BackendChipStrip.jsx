// Pill-style backend selector shared by ImageGen, VideoGen, and the Writers
// Room storyboard config. `size="md"` matches the standalone Image Gen
// page; `size="sm"` matches the storyboard's denser config tab.

import { Loader2 } from 'lucide-react';

const SIZES = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-2.5 py-1 text-xs',
};

export default function BackendChipStrip({
  availableBackends,
  value,
  onChange,
  disabled = false,
  size = 'md',
  ariaLabel = 'Backend',
  titlePrefix = 'Use',
  loadingId = null,
}) {
  if (!availableBackends?.length) return null;
  const sizeCls = SIZES[size] || SIZES.md;
  return (
    <div className="inline-flex max-w-full flex-wrap items-center gap-1 p-0.5 border border-port-border rounded-3xl bg-port-bg" role="group" aria-label={ariaLabel}>
      {availableBackends.map(({ id, label, icon: Icon }) => {
        const isLoading = loadingId === id;
        const isSelected = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange?.(id)}
            disabled={disabled}
            aria-busy={isLoading || undefined}
            className={`inline-flex min-h-[44px] min-w-[44px] max-w-full items-center justify-center gap-1 rounded-full transition-colors disabled:opacity-50 ${sizeCls} ${isSelected ? 'bg-port-accent text-white' : 'text-gray-400 hover:text-white hover:bg-port-border/40'}`}
            title={isLoading ? `Checking ${label}…` : `${titlePrefix} ${label}`}
          >
            {isLoading ? <Loader2 className="w-3 h-3 shrink-0 animate-spin" /> : <Icon className="w-3 h-3 shrink-0" />}
            <span className="min-w-0 break-words">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

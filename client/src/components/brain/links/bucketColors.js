/**
 * Bucket color presets — keyed to the PortOS design tokens plus a few extras.
 * Each preset carries full literal Tailwind class strings so the JIT compiler
 * picks them up (dynamic concatenation would be purged).
 */
export const BUCKET_COLORS = {
  accent: { dot: 'bg-port-accent', header: 'bg-port-accent/10 border-port-accent/40', text: 'text-port-accent' },
  success: { dot: 'bg-port-success', header: 'bg-port-success/10 border-port-success/40', text: 'text-port-success' },
  warning: { dot: 'bg-port-warning', header: 'bg-port-warning/10 border-port-warning/40', text: 'text-port-warning' },
  error: { dot: 'bg-port-error', header: 'bg-port-error/10 border-port-error/40', text: 'text-port-error' },
  purple: { dot: 'bg-purple-500', header: 'bg-purple-500/10 border-purple-500/40', text: 'text-purple-400' },
  pink: { dot: 'bg-pink-500', header: 'bg-pink-500/10 border-pink-500/40', text: 'text-pink-400' },
  cyan: { dot: 'bg-cyan-500', header: 'bg-cyan-500/10 border-cyan-500/40', text: 'text-cyan-400' },
  slate: { dot: 'bg-slate-500', header: 'bg-slate-500/10 border-slate-500/40', text: 'text-slate-300' }
};

export const BUCKET_COLOR_KEYS = Object.keys(BUCKET_COLORS);

// Drag-and-drop payload types — shared so a link dragged from the list or
// from another bucket, and a bucket dragged for reordering, are recognized
// by any drop target regardless of which component initiated the drag.
export const LINK_DND_TYPE = 'text/x-brain-link';
export const BUCKET_DND_TYPE = 'text/x-brain-bucket';

export function bucketColor(key) {
  return BUCKET_COLORS[key] || BUCKET_COLORS.accent;
}

/** Extract a clean hostname for favicon lookup; null if unparseable. */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Google favicon service URL for a link (64px), or null if no hostname. */
export function faviconUrl(url) {
  const host = hostnameOf(url);
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
}

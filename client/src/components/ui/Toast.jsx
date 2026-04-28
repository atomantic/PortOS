/**
 * Toast notification system — replaces react-hot-toast
 * Supports: toast(), toast.success(), toast.error(), toast.loading(), toast.dismiss(), <Toaster />
 * Render-prop toasts: toast((t) => <Component t={t} />, opts) — t has { id }
 */

import { useState, useEffect } from 'react';

let toasts = [];
const listeners = new Set();

function notify() {
  listeners.forEach(fn => fn([...toasts]));
}

const DEFAULT_DURATION = 4000;
const DEDUP_WINDOW_MS = 1500;

// Fingerprint → expiry timestamp. Same content+type within DEDUP_WINDOW_MS is
// silently dropped so a single user action that flows through multiple error
// channels (API client toast + socket error:occurred + error:notified) doesn't
// stack 3-4 identical red toasts. Render-prop content (functions) is never
// deduped — those are intentional custom UIs and the caller controls identity.
const recentFingerprints = new Map();
const fingerprintFor = (content, type) =>
  typeof content === 'string' ? `${type}::${content}` : null;

function add(content, opts = {}, type = 'default') {
  const id = opts.id || crypto.randomUUID();
  const duration = opts.duration !== undefined ? opts.duration : (type === 'loading' ? Infinity : DEFAULT_DURATION);

  // Skip if an identical toast was just shown — but only when the caller
  // didn't supply an explicit id (explicit id = caller is intentionally
  // updating the same toast, e.g. a loading-then-success swap).
  if (!opts.id) {
    const fp = fingerprintFor(content, type);
    if (fp) {
      const now = Date.now();
      // Sweep expired entries opportunistically.
      for (const [k, exp] of recentFingerprints) {
        if (exp <= now) recentFingerprints.delete(k);
      }
      const expiry = recentFingerprints.get(fp);
      if (expiry && expiry > now) return id;
      recentFingerprints.set(fp, now + DEDUP_WINDOW_MS);
    }
  }

  const entry = { id, type, content, icon: opts.icon, duration, style: opts.style };

  const idx = toasts.findIndex(t => t.id === id);
  toasts = idx !== -1
    ? [...toasts.slice(0, idx), entry, ...toasts.slice(idx + 1)]
    : [...toasts, entry];
  notify();

  if (duration !== Infinity) setTimeout(() => dismiss(id), duration);
  return id;
}

function dismiss(id) {
  toasts = id !== undefined ? toasts.filter(t => t.id !== id) : [];
  notify();
}

export const toast = Object.assign(
  (content, opts = {}) => add(content, opts, 'default'),
  {
    success: (content, opts = {}) => add(content, opts, 'success'),
    error:   (content, opts = {}) => add(content, opts, 'error'),
    loading: (content, opts = {}) => add(content, opts, 'loading'),
    dismiss,
  }
);

export default toast;

const TYPE_ICON = { success: '✓', error: '✕', loading: '⟳' };
const TYPE_CLASS = { success: 'text-green-400', error: 'text-red-400', loading: 'text-gray-400 animate-spin' };

export function Toaster({ position = 'bottom-right', toastOptions = {} }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const fn = ts => setItems(ts);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  const posClass = {
    'bottom-right':  'bottom-4 right-4 items-end',
    'bottom-left':   'bottom-4 left-4 items-start',
    'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 items-center',
    'top-right':     'top-4 right-4 items-end',
    'top-left':      'top-4 left-4 items-start',
    'top-center':    'top-4 left-1/2 -translate-x-1/2 items-center',
  }[position] ?? 'bottom-4 right-4 items-end';

  return (
    <div className={`fixed ${posClass} z-[9999] flex flex-col gap-2 pointer-events-none`}>
      {items.map(t => {
        const style = { padding: '12px 16px', borderRadius: '8px', ...toastOptions.style, ...t.style };
        const iconStr = t.icon ?? (t.type !== 'default' ? TYPE_ICON[t.type] : null);
        const iconClass = t.type !== 'default' ? TYPE_CLASS[t.type] : '';
        return (
          <div key={t.id} style={style} className="pointer-events-auto flex items-start gap-2 shadow-lg text-sm max-w-[520px] bg-port-card border border-port-border">
            {iconStr && <span className={`shrink-0 ${iconClass}`}>{iconStr}</span>}
            <div className="flex-1 min-w-0">
              {typeof t.content === 'function' ? t.content({ id: t.id }) : <span>{t.content}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

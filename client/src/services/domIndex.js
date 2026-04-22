// DOM indexer for voice accessibility mode.
//
// Walks the visible UI and produces a compact list of interactable elements
// (tabs, buttons, inputs, selects, etc.) each tagged with a stable ref.
// The server-side LLM receives this index per turn so it can drive the UI
// by label ("select the Memory tab", "fill search with 'foo'", etc.) via
// the ui_click / ui_fill / ui_select tools.

const MAX_ELEMENTS = 200;
const MAX_LABEL = 80;

const truncate = (s, n = MAX_LABEL) => {
  if (!s) return '';
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > n ? `${trimmed.slice(0, n - 1)}…` : trimmed;
};

const isVisible = (el) => {
  if (!el || !el.isConnected) return false;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
  // Fast-path: offsetParent is null for display:none ancestors and for
  // elements with display:none themselves. Catches ~80% of hidden cases
  // without forcing getComputedStyle/getBoundingClientRect layout reads.
  // Skips for position:fixed (offsetParent is always null) — for those we
  // fall through to the expensive checks.
  if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
};

const classify = (el) => {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'tab') return 'tab';
  if (role === 'menuitem') return 'button';
  if (tag === 'a' && el.href) return 'link';
  if (tag === 'button' || role === 'button') return 'button';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'input') {
    const type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'hidden' || type === 'file') return null;
    return 'input';
  }
  return null;
};

const extractLabel = (el) => {
  const aria = el.getAttribute('aria-label');
  if (aria) return truncate(aria);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .filter(Boolean);
    if (parts.length) return truncate(parts.join(' '));
  }

  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab?.textContent) return truncate(lab.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach((n) => n.remove());
      const t = clone.textContent;
      if (t && t.trim()) return truncate(t);
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return truncate(placeholder);
    const name = el.getAttribute('name');
    if (name) return truncate(name);
  }

  const text = el.textContent;
  if (text && text.trim()) return truncate(text);

  const title = el.getAttribute('title');
  if (title) return truncate(title);

  return null;
};

const SELECTOR = [
  'button',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  'a[href]',
  'input',
  'select',
  'textarea',
].join(', ');

export const clearRefs = () => {
  document.querySelectorAll('[data-voice-ref]').forEach((el) => {
    el.removeAttribute('data-voice-ref');
  });
};

const pickRoot = () => (
  document.querySelector('main')
  || document.getElementById('root')
  || document.body
);

const findTitle = () => {
  // Prefer a visible page heading over the tab title — it's the name the user
  // sees and what they'll naturally reference ("the tasks page").
  const h1 = document.querySelector('main h1, main [role="heading"][aria-level="1"]');
  if (h1?.textContent) return truncate(h1.textContent, 60);
  return truncate(document.title, 60);
};

export const buildIndex = () => {
  clearRefs();
  const root = pickRoot();
  const elements = [];
  const raw = Array.from(root.querySelectorAll(SELECTOR));

  for (const el of raw) {
    if (elements.length >= MAX_ELEMENTS) break;
    const kind = classify(el);
    if (!kind) continue;
    if (!isVisible(el)) continue;
    if (el.disabled) continue;

    const label = extractLabel(el);
    if (!label) continue;

    const ref = elements.length;
    el.setAttribute('data-voice-ref', String(ref));

    const entry = { ref, kind, label };

    if (kind === 'tab') {
      if (el.getAttribute('aria-selected') === 'true') entry.active = true;
    } else if (kind === 'input' || kind === 'textarea') {
      entry.type = (el.type || 'text').toLowerCase();
      if (el.value) entry.value = truncate(el.value, 80);
    } else if (kind === 'select') {
      entry.value = el.value;
      entry.options = Array.from(el.options)
        .slice(0, 30)
        .map((o) => o.textContent?.trim() || o.value)
        .filter(Boolean);
    } else if (kind === 'checkbox' || kind === 'radio') {
      entry.checked = !!el.checked;
    }

    elements.push(entry);
  }

  return {
    path: window.location.pathname + window.location.search,
    title: findTitle(),
    elements,
  };
};

const normalize = (s) => (s || '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[.!?:;,"']+$/, '');

export const findByRef = (ref) => {
  if (ref === undefined || ref === null) return null;
  return document.querySelector(`[data-voice-ref="${CSS.escape(String(ref))}"]`);
};

export const findByLabel = (label, kindHint) => {
  const target = normalize(label);
  if (!target) return null;
  const all = Array.from(document.querySelectorAll('[data-voice-ref]'));
  const candidates = all.map((el) => ({
    el,
    kind: classify(el),
    lab: normalize(extractLabel(el)),
  })).filter((c) => c.lab && c.kind);

  const withKind = kindHint ? candidates.filter((c) => c.kind === kindHint) : candidates;
  const pools = [withKind, candidates];
  const matchers = [
    (lab) => lab === target,
    (lab) => lab.startsWith(target),
    (lab) => lab.includes(target),
  ];
  for (const matcher of matchers) {
    for (const pool of pools) {
      const hit = pool.find((c) => matcher(c.lab));
      if (hit) return hit.el;
    }
  }
  return null;
};

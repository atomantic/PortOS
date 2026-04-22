// Executes voice UI commands (click / fill / select) against the live DOM.
// Resolves targets via the stable ref assigned by domIndex.js, falling back
// to label-based lookup when the ref is stale (DOM mutated between the
// server's last index push and the side-effect dispatch).

import { findByRef, findByLabel } from './domIndex.js';

const resolve = (target, kindHint) => {
  if (!target) return null;
  if (target.ref !== undefined && target.ref !== null) {
    const byRef = findByRef(target.ref);
    if (byRef) return byRef;
  }
  if (target.label) return findByLabel(target.label, kindHint);
  return null;
};

export const doClick = (target) => {
  const el = resolve(target);
  if (!el) return { ok: false, reason: 'not-found' };
  el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  el.focus?.();
  el.click();
  return { ok: true };
};

// React's controlled inputs ignore `.value = x` because React caches the
// previous value on the prototype. Use the native setter so React's onChange
// sees a real change.
const setNativeValue = (el, value) => {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, String(value));
  else el.value = String(value);
};

export const doFill = (target, value) => {
  let el = resolve(target, 'input');
  if (!el) el = resolve(target, 'textarea');
  if (!el) return { ok: false, reason: 'not-found' };
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
    return { ok: false, reason: 'not-fillable' };
  }
  el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  el.focus?.();
  setNativeValue(el, value ?? '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
};

export const doSelect = (target, option) => {
  const el = resolve(target, 'select');
  if (!el) return { ok: false, reason: 'not-found' };
  if (el.tagName !== 'SELECT') return { ok: false, reason: 'not-selectable' };
  const wanted = String(option).toLowerCase().trim();
  const opts = Array.from(el.options);
  const match = opts.find((o) => (o.value || '').toLowerCase() === wanted)
    || opts.find((o) => (o.textContent || '').toLowerCase().trim() === wanted)
    || opts.find((o) => (o.textContent || '').toLowerCase().includes(wanted))
    || opts.find((o) => (o.value || '').toLowerCase().includes(wanted));
  if (!match) return { ok: false, reason: 'no-option' };
  el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  setNativeValue(el, match.value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
};

export const doSetCheckbox = (target, checked) => {
  const el = resolve(target, 'checkbox') || resolve(target, 'radio');
  if (!el) return { ok: false, reason: 'not-found' };
  const desired = !!checked;
  if (el.checked === desired) return { ok: true, noop: true };
  el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  el.click();
  return { ok: true };
};

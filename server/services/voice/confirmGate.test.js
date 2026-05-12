import { describe, it, expect } from 'vitest';
import {
  DESTRUCTIVE_LABEL_RE,
  isDestructiveLabel,
  isAffirmative,
  isNegative,
  buildPending,
  resolvePending,
  isExpired,
  PENDING_TTL_MS,
} from './confirmGate.js';

describe('isDestructiveLabel', () => {
  it.each([
    ['Delete', true],
    ['delete account', true],
    ['Remove member', true],
    ['Discard changes', true],
    ['Reset to defaults', true],
    ['Clear filters', true],
    ['DELETE', true],
  ])('matches %s → %s', (label, expected) => {
    expect(isDestructiveLabel(label)).toBe(expected);
  });

  it.each([
    ['Save', false],
    ['Cancel', false],
    ['Cancellation', false],
    ['Resettable', false], // word boundary blocks substring
    ['Removable', false],
    ['Cleared session', false], // trailing "ed" breaks the word boundary
    ['', false],
  ])('correctly classifies %s → %s', (label, expected) => {
    expect(isDestructiveLabel(label)).toBe(expected);
  });

  it('matches the exact words clear/delete/remove/discard/reset', () => {
    // Word boundary on both sides — "Clear filters" matches; "Cleared" does not.
    // Safe-by-default: a false-positive (extra confirm) is fine; a false-negative
    // (no gate) means a destructive click fires silently. We pick narrow matching.
    expect(DESTRUCTIVE_LABEL_RE.test('Clear filters')).toBe(true);
    expect(DESTRUCTIVE_LABEL_RE.test('Cleared session')).toBe(false);
  });
});

describe('isAffirmative / isNegative', () => {
  it.each([
    'confirm',
    'yes',
    'yes do it',
    'yes, please',
    'do it',
    'go ahead',
    'proceed',
    'continue',
    'affirmative',
    'OK',
    'okay',
    'Confirm.',
  ])('treats "%s" as affirmative', (s) => {
    expect(isAffirmative(s)).toBe(true);
    expect(isNegative(s)).toBe(false);
  });

  it.each([
    'no',
    'cancel',
    'stop',
    'nope',
    'never mind',
    'nevermind',
    "don't",
    'dont',
    'abort',
    'negative',
  ])('treats "%s" as negative', (s) => {
    expect(isNegative(s)).toBe(true);
    expect(isAffirmative(s)).toBe(false);
  });

  it('rejects unrelated sentences as neither', () => {
    for (const s of [
      'what time is it?',
      'open my brain inbox',
      'tell me a joke',
      'remember to buy milk',
    ]) {
      expect(isAffirmative(s)).toBe(false);
      expect(isNegative(s)).toBe(false);
    }
  });

  it('strips surrounding quotes and trailing punctuation', () => {
    expect(isAffirmative('"confirm"')).toBe(true);
    expect(isAffirmative('yes!')).toBe(true);
    expect(isNegative('cancel.')).toBe(true);
  });

  // "okay cancel" / "ok no" etc. — bare "ok/okay" matches AFFIRM_RE, so
  // without filler-tolerance in NEGATIVE_RE the user's intended cancel would
  // be mis-executed as a destructive confirmation.
  it.each([
    'okay cancel',
    'okay never mind',
    'ok no',
    'okay stop',
    'ok cancel',
  ])('treats filler "%s" as negative, not affirmative', (s) => {
    expect(isNegative(s)).toBe(true);
  });
});

describe('resolvePending', () => {
  const pending = buildPending({
    tool: 'ui_click',
    args: { label: 'Delete' },
    target: { ref: 5, label: 'Delete', kind: 'button' },
  });

  it('returns passthrough when no pending', () => {
    expect(resolvePending(null, 'yes').action).toBe('passthrough');
  });

  it('execute on affirmative', () => {
    const d = resolvePending(pending, 'yes');
    expect(d.action).toBe('execute');
    expect(d.pending).toBe(pending);
  });

  it('cancel on negative', () => {
    const d = resolvePending(pending, 'cancel');
    expect(d.action).toBe('cancel');
  });

  it('passthrough on ambiguous (user moved on without yes/no)', () => {
    const d = resolvePending(pending, 'what time is it?');
    expect(d.action).toBe('passthrough');
  });

  it('execute on "confirm"', () => {
    expect(resolvePending(pending, 'confirm').action).toBe('execute');
  });

  it('cancel on "stop"', () => {
    expect(resolvePending(pending, 'stop').action).toBe('cancel');
  });

  // Regression guard for the "okay cancel" class: negative must win over
  // affirmative when the user prefixes a cancel word with "ok/okay".
  it.each([
    ['okay cancel', 'cancel'],
    ['ok no', 'cancel'],
    ['okay never mind', 'cancel'],
  ])('classifies "%s" as %s (negative beats affirmative filler)', (utterance, expected) => {
    expect(resolvePending(pending, utterance).action).toBe(expected);
  });
});

describe('buildPending shape', () => {
  it('records tool/args/target with createdAt', () => {
    const before = Date.now();
    const p = buildPending({
      tool: 'ui_click',
      args: { label: 'Reset' },
      target: { ref: 7, label: 'Reset', kind: 'button' },
    });
    expect(p.tool).toBe('ui_click');
    expect(p.args).toEqual({ label: 'Reset' });
    expect(p.target).toEqual({ ref: 7, label: 'Reset', kind: 'button' });
    expect(p.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('accepts an injected createdAt for deterministic tests', () => {
    const p = buildPending({
      tool: 'ui_click',
      args: { label: 'Delete' },
      target: { ref: 1, label: 'Delete', kind: 'button' },
      createdAt: 12345,
    });
    expect(p.createdAt).toBe(12345);
  });
});

describe('isExpired', () => {
  it('returns false for fresh pending', () => {
    const p = buildPending({ tool: 'ui_click', args: {}, target: {} });
    expect(isExpired(p, Date.now())).toBe(false);
  });

  it('returns true when older than TTL', () => {
    const p = { tool: 'ui_click', args: {}, target: {}, createdAt: Date.now() - PENDING_TTL_MS - 1 };
    expect(isExpired(p)).toBe(true);
  });

  it('returns false for null pending', () => {
    expect(isExpired(null)).toBe(false);
  });
});

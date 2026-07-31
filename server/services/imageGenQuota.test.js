import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_ROOT = await mkdtemp(join(tmpdir(), 'portos-igquota-'));
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  actual.PATHS.data = TEST_ROOT;
  return actual;
});

const {
  parseImageQuotaSignal,
  recordImageGenOutcome,
  getImageGenQuota,
  isQuotaTrackedImageMode,
  initImageGenQuotaHook,
  __resetImageGenQuotaHookForTests,
} = await import('./imageGenQuota.js');
const { imageGenEvents } = await import('./imageGenEvents.js');

// The verbatim shape Antigravity returned on 2026-07-31 (paths/ids redacted).
const AGY_429 = 'Agy did not produce an image at the directed path. Agy said: "Here is the error details returned by the API: * **Error Code**: 429 (Resource Exhausted) * **Message**: You have exhausted your capacity on this model. Your quota will reset in approximately 5 hours (around 2026-07-31T21:38:09Z). Since the `generate_image` tool relies entirely on this backend service, I am currently unable to write the requested image to `/tmp/portos-agy-<id>/output.png`. Please try again after the quota resets."';

beforeEach(async () => {
  __resetImageGenQuotaHookForTests();
  imageGenEvents.removeAllListeners();
  await rm(join(TEST_ROOT, 'imagegen-quota.json'), { force: true });
});
afterEach(async () => {
  await rm(join(TEST_ROOT, 'imagegen-quota.json'), { force: true });
});

describe('parseImageQuotaSignal', () => {
  it('reads the exact 429 the imagen backend returned', () => {
    const signal = parseImageQuotaSignal(AGY_429);
    expect(signal.exhausted).toBe(true);
    // The parenthetical absolute instant beats the "approximately 5 hours".
    expect(new Date(signal.resetsAt).toISOString()).toBe('2026-07-31T21:38:09.000Z');
  });

  it('falls back to the relative window when no absolute time is given', () => {
    const now = Date.parse('2026-07-31T16:38:09Z');
    const signal = parseImageQuotaSignal('429: quota will reset in approximately 5 hours.', { now });
    expect(signal.exhausted).toBe(true);
    expect(new Date(signal.resetsAt).toISOString()).toBe('2026-07-31T21:38:09.000Z');
  });

  it('marks a quota block even when no reset time is stated', () => {
    expect(parseImageQuotaSignal('RESOURCE_EXHAUSTED')).toEqual({ exhausted: true, resetsAt: null });
  });

  it('does not treat a content decline as a quota block', () => {
    // Misreading this would show a phantom "0% left" meter with no reset.
    const signal = parseImageQuotaSignal('Agy said: "I cannot generate that image."');
    expect(signal.exhausted).toBe(false);
  });

  it('does not treat prompt content echoed in a decline as a quota block', () => {
    // The classified text is the model's own narration, which quotes the image
    // prompt back. A bare "credit"/"payment" in the artwork description must
    // never read as a billing failure and paint a phantom 0%-left meter.
    const decline = 'Agy said: "I cannot generate that image: a wizard holding a credit card and a payment terminal."';
    expect(parseImageQuotaSignal(decline).exhausted).toBe(false);
  });

  it('still catches a genuine out-of-credits refusal', () => {
    // The precise phrasing survives — only the bare-word match was dropped.
    expect(parseImageQuotaSignal('Render failed: you are out of credits.').exhausted).toBe(true);
  });

  it('inherits rate-limit phrasings the shared CLI classifier already knows', () => {
    expect(parseImageQuotaSignal('Grok said: "too many requests, slow down"').exhausted).toBe(true);
  });

  it('does not treat a crashed CLI as a quota block', () => {
    expect(parseImageQuotaSignal('Agy generation failed: Exit code 1').exhausted).toBe(false);
    expect(parseImageQuotaSignal('Failed to spawn agy: ENOENT').exhausted).toBe(false);
    expect(parseImageQuotaSignal('').exhausted).toBe(false);
  });
});

describe('isQuotaTrackedImageMode', () => {
  it('tracks the cloud CLIs and ignores local/external', () => {
    expect(isQuotaTrackedImageMode('agy')).toBe(true);
    expect(isQuotaTrackedImageMode('grok')).toBe(true);
    expect(isQuotaTrackedImageMode('codex')).toBe(true);
    // Local renders on the user's own GPU — there is no remote quota to report.
    expect(isQuotaTrackedImageMode('local')).toBe(false);
    expect(isQuotaTrackedImageMode('external')).toBe(false);
  });
});

describe('initImageGenQuotaHook', () => {
  // The recorder rides the imageGenEvents bus rather than provider finalizers,
  // so a backend that emits on the bus is tracked without touching its code.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('records a refused render announced on the bus', async () => {
    initImageGenQuotaHook();
    imageGenEvents.emit('failed', { mode: 'agy', generationId: 'j1', error: AGY_429 });
    await flush();
    const card = await getImageGenQuota({ enabledModes: ['agy'] });
    expect(card.limits[0].resetsAt).toBe('2026-07-31T21:38:09.000Z');
  });

  it('ignores a local render on the same bus', async () => {
    initImageGenQuotaHook();
    imageGenEvents.emit('completed', { mode: 'local', generationId: 'j2' });
    await flush();
    const card = await getImageGenQuota({ enabledModes: ['agy'] });
    expect(card.metrics[0].value).toBe('No renders · 24h');
  });

  it('subscribes only once across repeated boots', async () => {
    initImageGenQuotaHook();
    initImageGenQuotaHook();
    imageGenEvents.emit('completed', { mode: 'agy', generationId: 'j3' });
    await flush();
    const card = await getImageGenQuota({ enabledModes: ['agy'] });
    // A double subscription would count this single render twice.
    expect(card.metrics[0].value).toBe('1 render · 24h');
  });
});

describe('getImageGenQuota', () => {
  const now = Date.parse('2026-07-31T17:00:00Z');

  it('renders no card at all when no cloud image backend is enabled', async () => {
    // Local renders spend no remote quota — one "should there be a card"
    // decision, made here, rather than a second not-supported state.
    expect(await getImageGenQuota({ enabledModes: ['local'], now })).toBe(null);
    expect(await getImageGenQuota({ enabledModes: [], now })).toBe(null);
  });

  it('marks the card unburnable so quota-burn never targets it', async () => {
    // These cards carry no measurable headroom; a 0%-left image meter must not
    // read to the quota-burn candidate feed as capacity to spend down.
    await recordImageGenOutcome({ mode: 'agy', ok: true, at: now });
    expect((await getImageGenQuota({ enabledModes: ['agy'], now })).burnable).toBe(false);
  });

  it('surfaces a real 0%-left meter with the provider-stated reset', async () => {
    await recordImageGenOutcome({ mode: 'agy', ok: false, error: AGY_429, at: now });
    const card = await getImageGenQuota({ enabledModes: ['agy'], now });
    expect(card.limits).toHaveLength(1);
    expect(card.limits[0]).toMatchObject({
      label: 'Agy · generate_image',
      percentUsed: 100,
      percentRemaining: 0,
      resetsAt: '2026-07-31T21:38:09.000Z',
    });
  });

  it('reports observed render counts rather than inventing a percentage', async () => {
    // The whole point of the card: a quota we cannot query must never render
    // as a reassuring "100% left" meter.
    await recordImageGenOutcome({ mode: 'agy', ok: true, at: now });
    await recordImageGenOutcome({ mode: 'agy', ok: true, at: now });
    const card = await getImageGenQuota({ enabledModes: ['agy'], now });
    expect(card.limits).toEqual([]);
    expect(card.metrics).toHaveLength(1);
    expect(card.metrics[0].value).toBe('2 renders · 24h');
    expect(card.metrics[0].detail).toContain('quota not reported');
  });

  it('drops the block once its stated reset has passed', async () => {
    await recordImageGenOutcome({ mode: 'agy', ok: false, error: AGY_429, at: now });
    const after = Date.parse('2026-07-31T21:40:00Z');
    const card = await getImageGenQuota({ enabledModes: ['agy'], now: after });
    expect(card.limits).toEqual([]);
  });

  it('clears a stale block as soon as a render succeeds again', async () => {
    // Providers round "approximately", so a success is stronger evidence than
    // the stated reset time — without this the card lies until the clock says so.
    await recordImageGenOutcome({ mode: 'agy', ok: false, error: AGY_429, at: now });
    await recordImageGenOutcome({ mode: 'agy', ok: true, at: now + 60_000 });
    const card = await getImageGenQuota({ enabledModes: ['agy'], now: now + 120_000 });
    expect(card.limits).toEqual([]);
  });

  it('does not block on a non-quota failure', async () => {
    await recordImageGenOutcome({ mode: 'agy', ok: false, error: 'Exit code 1', at: now });
    const card = await getImageGenQuota({ enabledModes: ['agy'], now });
    expect(card.limits).toEqual([]);
    expect(card.metrics[0].detail).toBe('1 failed');
  });

  it('keeps each backend independent', async () => {
    await recordImageGenOutcome({ mode: 'agy', ok: false, error: AGY_429, at: now });
    await recordImageGenOutcome({ mode: 'grok', ok: true, at: now });
    const card = await getImageGenQuota({ enabledModes: ['agy', 'grok'], now });
    expect(card.limits.map((l) => l.model)).toEqual(['Agy']);
    expect(card.metrics.map((m) => m.label)).toEqual(['Grok · image_gen']);
  });

  it('ignores an untracked mode handed to the recorder', async () => {
    await recordImageGenOutcome({ mode: 'local', ok: false, error: AGY_429, at: now });
    const card = await getImageGenQuota({ enabledModes: ['agy'], now });
    expect(card.limits).toEqual([]);
  });

  it('survives a process restart', async () => {
    // State lives only on disk — no in-memory mirror to warm.
    await recordImageGenOutcome({ mode: 'agy', ok: false, error: AGY_429, at: now });
    const card = await getImageGenQuota({ enabledModes: ['agy'], now });
    expect(card.limits[0].resetsAt).toBe('2026-07-31T21:38:09.000Z');
  });

  it('reports an unreadable ledger as an error, not as zero renders', async () => {
    // "Could not read" must never render as a reassuring "No renders · 24h" —
    // that would also silently hide an active block.
    await writeFile(join(TEST_ROOT, 'imagegen-quota.json'), '{ this is not json');
    const card = await getImageGenQuota({ enabledModes: ['agy'], now });
    expect(card.error).toContain('Could not read');
    expect(card.metrics).toEqual([]);
  });

  it('ages renders out of the 24h window', async () => {
    await recordImageGenOutcome({ mode: 'agy', ok: true, at: now - 25 * 60 * 60 * 1000 });
    await recordImageGenOutcome({ mode: 'agy', ok: true, at: now });
    const card = await getImageGenQuota({ enabledModes: ['agy'], now });
    expect(card.metrics[0].value).toBe('1 render · 24h');
  });
});

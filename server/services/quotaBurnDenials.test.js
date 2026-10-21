import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-burn-denials-', extraOverrides: (root) => ({ cos: root }) });
vi.mock('../lib/fileUtils.js', async (importActual) => makeProxy(await importActual()));

const {
  clearQuotaBurnBlock, getActiveQuotaBurnBlocks, getQuotaBurnDenials, isBlockActive,
  parseQuotaDenial, recordBurnAgentCompletion, recordQuotaBurnDenial, UNKNOWN_BLOCK_TTL_MS,
} = await import('./quotaBurnDenials.js');

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

beforeEach(() => rmSync(join(tempRoot, 'quota-burn-denials.json'), { force: true }));
afterAll(cleanup);

describe('parseQuotaDenial', () => {
  it('trusts a STRUCTURED usage-limit verdict the failure analyzer already produced', () => {
    // `analyzeAgentFailure` classifies exactly this condition and anchors its
    // patterns to provider-billing idioms — re-deriving it here would be a
    // second, drifting copy of the same judgement.
    const analyzed = { category: 'usage-limit', origin: 'provider' };
    expect(parseQuotaDenial('', { now: NOW, errorAnalysis: analyzed }).denied).toBe(true);
    // ...but only when it came from a structured marker. The same category is
    // also reached by a loose keyword sweep over the agent's own narration,
    // which is the false-positive class the pattern list guards against — so a
    // loose match falls through to those patterns instead of being trusted.
    expect(parseQuotaDenial('reviewing the daily limit copy', {
      now: NOW, errorAnalysis: { category: 'usage-limit', origin: 'output-scan' },
    }).denied).toBe(false);
  });

  it('matches a subscription-window refusal in the run output', () => {
    expect(parseQuotaDenial('Claude usage limit reached', { now: NOW }).denied).toBe(true);
    expect(parseQuotaDenial('You have hit your usage limit', { now: NOW }).denied).toBe(true);
    expect(parseQuotaDenial('5-hour limit reached for this account', { now: NOW }).denied).toBe(true);
  });

  it('does NOT block on a transient rate limit or on prompt text about quotas', () => {
    // A 429 is a retry, not a spent window — and blocking a family for hours
    // over one is far worse than missing a burn. The output being classified is
    // the agent's own narration, which quotes the prompt it was given.
    expect(parseQuotaDenial('API Error: 429 too many requests', { now: NOW }).denied).toBe(false);
    expect(parseQuotaDenial('Reviewing the quota limit handling in quotaBurn.js', { now: NOW }).denied).toBe(false);
    expect(parseQuotaDenial('', { now: NOW }).denied).toBe(false);
    expect(parseQuotaDenial(null, { now: NOW }).denied).toBe(false);
  });

  it('reads the reset the provider stated, absolute before relative', () => {
    const absolute = parseQuotaDenial(
      'hit your usage limit — quota will reset in approximately 5 hours (around 2026-07-26T15:00:00Z)',
      { now: NOW },
    );
    expect(absolute.resetsAt).toBe(Date.parse('2026-07-26T15:00:00Z'));
    const relative = parseQuotaDenial('hit your usage limit, try again in 45 minutes', { now: NOW });
    expect(relative.resetsAt).toBe(NOW + 45 * 60_000);
  });

  it('re-frames the analyzer\'s stripped wait phrase so it still parses', () => {
    // The usage-limit extractor yields `waitTime: '45 minutes'` — the lead-in
    // ("try again in ") is already consumed by its own pattern.
    const signal = parseQuotaDenial('', {
      now: NOW,
      errorAnalysis: { category: 'usage-limit', origin: 'provider', waitTime: '45 minutes' },
    });
    expect(signal.resetsAt).toBe(NOW + 45 * 60_000);
  });
});

describe('recordQuotaBurnDenial', () => {
  it('blocks the family until the reset the provider stated', async () => {
    const entry = await recordQuotaBurnDenial({
      familyId: 'claude',
      output: 'hit your usage limit — try again in 3 hours',
      at: NOW,
    });
    expect(entry.until).toBe(NOW + 3 * 3_600_000);
    await expect(getActiveQuotaBurnBlocks({ now: NOW })).resolves.toHaveProperty('claude');
    await expect(getActiveQuotaBurnBlocks({ now: entry.until + 1 })).resolves.toEqual({});
  });

  it('falls back to the SHORT window\'s reset when the refusal states none', async () => {
    // The 5-hour window is what a weekly burn plan actually runs out of, so it
    // is the right clock to wait on — the weekly card still reads healthy.
    const limitingResetAt = NOW + 2 * 3_600_000;
    const entry = await recordQuotaBurnDenial({
      familyId: 'codex', output: 'usage limit reached', limitingResetAt, at: NOW,
    });
    expect(entry.until).toBe(limitingResetAt);
  });

  it('never downgrades a known reset to unknown on a repeat refusal', async () => {
    // A second refusal during an active block typically restates nothing;
    // erasing the first instant would silently shorten the block to the TTL.
    await recordQuotaBurnDenial({ familyId: 'claude', output: 'hit your usage limit — try again in 3 hours', at: NOW });
    const repeat = await recordQuotaBurnDenial({ familyId: 'claude', output: 'usage limit reached', at: NOW + 60_000 });
    expect(repeat.until).toBe(NOW + 3 * 3_600_000);
  });

  it('falls back to the TTL when the prior reset has already lapsed', async () => {
    await recordQuotaBurnDenial({ familyId: 'claude', output: 'hit your usage limit — try again in 3 hours', at: NOW });
    const later = NOW + 4 * 3_600_000;
    const repeat = await recordQuotaBurnDenial({ familyId: 'claude', output: 'usage limit reached', at: later });
    expect(repeat.until).toBeNull();
    await expect(getActiveQuotaBurnBlocks({ now: later + 1 })).resolves.toHaveProperty('claude');
  });

  it('records nothing for a failure that is not a quota refusal', async () => {
    await expect(recordQuotaBurnDenial({ familyId: 'claude', output: 'ENOENT: no such file', at: NOW })).resolves.toBeNull();
    await expect(getQuotaBurnDenials()).resolves.toEqual({});
  });

  it('bounds a reset-less block on the TTL instead of holding forever', async () => {
    // Nothing forces a later burn to happen and prove the family is serving
    // again, so an unbounded block would strand the feature.
    const entry = await recordQuotaBurnDenial({ familyId: 'agy', output: 'usage limit reached', at: NOW });
    expect(entry.until).toBeNull();
    expect(isBlockActive(entry, NOW + UNKNOWN_BLOCK_TTL_MS - 1)).toBe(true);
    expect(isBlockActive(entry, NOW + UNKNOWN_BLOCK_TTL_MS)).toBe(false);
    // An absent block arrives as either shape from a ledger lookup.
    expect(isBlockActive(undefined, NOW)).toBe(false);
    expect(isBlockActive(null, NOW)).toBe(false);
  });

  it('never clobbers a ledger it could not read', async () => {
    // A corrupt/unreadable file must not read as "nothing is blocked" — that
    // re-opens the gate on a family the provider is still refusing AND lets the
    // next write replace the surviving blocks with an empty object.
    await recordQuotaBurnDenial({ familyId: 'claude', output: 'usage limit reached', at: NOW });
    writeFileSync(join(tempRoot, 'quota-burn-denials.json'), '{ not json');
    await expect(getQuotaBurnDenials()).resolves.toBeNull();
    await expect(getActiveQuotaBurnBlocks({ now: NOW })).resolves.toEqual({});
    await recordQuotaBurnDenial({ familyId: 'codex', output: 'usage limit reached', at: NOW });
    expect(readFileSync(join(tempRoot, 'quota-burn-denials.json'), 'utf-8')).toBe('{ not json');
  });

  it('does not lose a block when two denials race', async () => {
    await Promise.all([
      recordQuotaBurnDenial({ familyId: 'claude', output: 'usage limit reached', at: NOW }),
      recordQuotaBurnDenial({ familyId: 'codex', output: 'usage limit reached', at: NOW }),
    ]);
    await expect(getQuotaBurnDenials()).resolves.toHaveProperty('codex');
    await expect(getQuotaBurnDenials()).resolves.toHaveProperty('claude');
  });
});

describe('clearQuotaBurnBlock', () => {
  it('clears on a successful burn — the provider serving IS the proof', async () => {
    await recordQuotaBurnDenial({ familyId: 'claude', output: 'usage limit reached', at: NOW });
    await clearQuotaBurnBlock('claude');
    await expect(getQuotaBurnDenials()).resolves.toEqual({});
  });

  it('is a no-op when the family was never blocked', async () => {
    await expect(clearQuotaBurnBlock('grok')).resolves.toBeNull();
    await expect(clearQuotaBurnBlock(null)).resolves.toBeNull();
  });
});

/**
 * Only agents a burn dispatched carry `taskQuotaBurnFamily`. An unrelated task
 * that happens to hit a usage limit says nothing about whether the burn plan may
 * spend — blocking on it would stall the feature over someone else's failure.
 */
describe('recordBurnAgentCompletion', () => {
  const burnAgent = (metadata, result) => ({
    metadata: { taskQuotaBurnFamily: 'claude', ...metadata }, result,
  });
  const refused = { success: false, errorAnalysis: { category: 'usage-limit', origin: 'provider', message: 'Usage limit exceeded' } };

  it('blocks the family until the limiting window rolls when a burn is refused', async () => {
    await recordBurnAgentCompletion(burnAgent({ taskQuotaBurnLimitingResetAt: Date.now() + 3_600_000 }, refused));
    await expect(getQuotaBurnDenials()).resolves.toHaveProperty('claude');
  });

  it('reads a limiting reset that round-tripped through COS-TASKS.md as a string', async () => {
    // Task metadata comes back off the markdown store stringified; projecting it
    // unchanged would fail the `Number.isFinite` guard and silently downgrade
    // every block to the TTL.
    const until = Date.now() + 2 * 3_600_000;
    await recordBurnAgentCompletion(burnAgent({ taskQuotaBurnLimitingResetAt: String(until) }, refused));
    const ledger = await getQuotaBurnDenials();
    expect(ledger.claude.until).toBe(until);
  });

  it('ignores an agent that was not dispatched by a burn', async () => {
    await recordBurnAgentCompletion({ metadata: {}, result: refused });
    await expect(getQuotaBurnDenials()).resolves.toEqual({});
  });

  it('clears the block when a burn run succeeds', async () => {
    await recordQuotaBurnDenial({ familyId: 'claude', output: 'usage limit reached', at: NOW });
    await recordBurnAgentCompletion(burnAgent({}, { success: true }));
    await expect(getQuotaBurnDenials()).resolves.toEqual({});
  });

  it('leaves the ledger alone for a burn that failed for an unrelated reason', async () => {
    await recordBurnAgentCompletion(burnAgent({}, {
      success: false, errorAnalysis: { category: 'bad-request', message: 'Bad request' },
    }));
    await expect(getQuotaBurnDenials()).resolves.toEqual({});
  });
});

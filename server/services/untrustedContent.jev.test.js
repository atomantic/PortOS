import { jevEvents } from './jevEvents.js';
/**
 * The jev rung of the screen → reason → validate ladder.
 *
 * Kept in its own file rather than folded into `untrustedContent.test.js`
 * because every case here needs the scorer and the instance-feature gate
 * doubled, and that suite's whole point is that the chat path is unchanged when
 * neither exists.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const mocks = vi.hoisted(() => ({
  scan: vi.fn(), fetch: vi.fn(), read: vi.fn(), providers: vi.fn(),
  decide: vi.fn(), feature: vi.fn(),
}));
vi.mock('./modelAbuseGuard.js', () => ({ runModelAbuseScan: mocks.scan }));
vi.mock('./settings.js', () => ({ readSettingsStrict: mocks.read }));
vi.mock('./providers.js', () => ({ getAllProviders: mocks.providers }));
vi.mock('./providerExecutionReadiness.js', () => ({ ensureProviderReadyForExecution: async () => ({ success: true }) }));
vi.mock('./jev.js', () => ({ decide: mocks.decide }));
vi.mock('./instanceFeatures.js', () => ({ isInstanceFeatureEnabled: mocks.feature }));
// The counters store runs for real against a temp data root, so these
// assertions describe the bytes an install would actually keep — which is the
// point of the privacy case below.
const { makeProxy, tempRoot, cleanup } = mockPathsDataRoot({ prefix: 'portos-jev-shadow-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));

import { JEV_DECISIONS, jevHypotheses } from '../lib/jevDecisions.js';
// Dynamic: a static import is hoisted above `makeProxy`'s initializer, so the
// mock factory would run before the temp data root exists.
const { jevBatchGate, runUntrustedContentAnalysis } = await import('./untrustedContent.js');
const { resetJevShadowCache, recordJevObservations } = await import('./jevRouter.js');

const local = { id: 'local', type: 'api', enabled: true, endpoint: 'http://127.0.0.1:11434/v1', defaultModel: 'example-text' };
const dispositionSchema = z.object({
  disposition: z.enum(['inspect-trusted-change', 'defer']),
  concerns: z.array(z.enum(['prompt-injection'])).max(1),
}).strict();
const jevPlan = {
  decisions: [{ id: 'forge-maintenance-disposition', premise: 'Example discussion about a merged change.' }],
  toValue: (choices) => ({ disposition: choices['forge-maintenance-disposition'], concerns: [] }),
  fromValue: (value) => ({ 'forge-maintenance-disposition': value.disposition }),
};
const args = {
  content: 'Example discussion about a merged change.',
  prompt: 'Return {"disposition":"defer","concerns":[]}.',
  // GitHub also requires a text security-model verdict, covered separately.
  source: 'stacker-news',
  responseSchema: dispositionSchema,
};
const completion = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));

/** A scorer verdict naming one option of a shipped decision by its hypothesis. */
const chose = (decisionId, value, margin) => {
  const option = JEV_DECISIONS[decisionId].options.find((entry) => entry.value === value);
  return { ok: true, choice: option.hypothesis, confidence: 0.9, margin, abstained: false };
};
const abstained = (margin = 0.01) => ({ ok: true, choice: null, confidence: null, margin, abstained: true });

const withPolicy = (policy) => mocks.read.mockResolvedValue({
  corrupt: false, settings: { untrustedContent: { defaults: policy } },
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.read.mockResolvedValue({ corrupt: false, settings: {} });
  mocks.providers.mockResolvedValue({ providers: [local] });
  mocks.scan.mockResolvedValue({ ok: true, safe: true });
  mocks.feature.mockResolvedValue(true);
  mocks.fetch.mockImplementation(async () => completion('{"disposition":"defer","concerns":[]}'));
  await rm(shadowFile, { force: true });
  resetJevShadowCache();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => cleanup());

const shadowFile = join(tempRoot, 'local-llm', 'jev-shadow.json');
const readShadow = async () => JSON.parse(await readFile(shadowFile, 'utf8'));

describe('jev rung of the untrusted-content ladder', () => {
  it('answers from the scorer with zero provider calls, and asks the shipped hypotheses in order', async () => {
    withPolicy({ jevMode: 'prefer' });
    mocks.decide.mockResolvedValue(chose('forge-maintenance-disposition', 'defer', 0.8));
    const result = await runUntrustedContentAnalysis({ ...args, jev: jevPlan });
    expect(result).toMatchObject({ ok: true, via: 'jev', value: { disposition: 'defer', concerns: [] } });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      options: jevHypotheses('forge-maintenance-disposition'),
    }));
  });

  it('disabled source uses chat without shadow scoring in both analysis paths', async () => {
    withPolicy({ jevMode: 'disabled' });
    expect(await runUntrustedContentAnalysis({ ...args, jev: jevPlan })).toMatchObject({ ok: true });
    const gate = await jevBatchGate({ content: args.content, source: args.source,
      items: [{ key: 'a', premise: 'x', decisionIds: ['issue-comment-reply'] }],
    });
    await gate.measure?.({ a: { 'issue-comment-reply': 'none' } });
    expect(gate.pending).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('never consults the scorer for content phase 1 blocked', async () => {
    withPolicy({ jevMode: 'prefer' });
    mocks.scan.mockResolvedValue({ ok: true, safe: false, code: 'model-abuse-detected' });
    expect(await runUntrustedContentAnalysis({ ...args, jev: jevPlan })).toMatchObject({ ok: false });
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    // Same guarantee on the batch entry point, which screens for itself.
    mocks.decide.mockClear();
    const gate = await jevBatchGate({
      content: args.content, source: args.source,
      items: [{ key: 'a', premise: 'x', decisionIds: ['issue-comment-reply'] }],
    });
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(gate.decided.size).toBe(0);
    expect(gate.pending).toHaveLength(1);
  });

  it('holds a destructive option to a wider margin than the option beside it', async () => {
    withPolicy({ jevMode: 'prefer' });
    // 0.30 clears `message-triage`'s 0.25 decision floor but not `delete`'s own
    // 0.60 floor, so the same margin decides for `archive` and abstains for
    // `delete`. Without the per-option floor the mail would be discarded.
    mocks.decide.mockResolvedValue(chose('message-triage', 'delete', 0.3));
    const discard = await jevBatchGate({
      content: args.content, source: 'email',
      items: [{ key: 'a', premise: 'x', decisionIds: ['message-triage'] }],
    });
    expect(discard.decided.size).toBe(0);
    mocks.decide.mockResolvedValue(chose('message-triage', 'archive', 0.3));
    const file = await jevBatchGate({
      content: args.content, source: 'email',
      items: [{ key: 'a', premise: 'x', decisionIds: ['message-triage'] }],
    });
    expect(file.decided.get('a')).toEqual({ 'message-triage': 'archive' });
  });

  it('lets the operator margin raise a floor but never lower one', async () => {
    mocks.decide.mockResolvedValue(chose('issue-comment-reply', 'none', 0.3));
    withPolicy({ jevMode: 'prefer', jevMinMargin: 0 });
    const relaxed = await jevBatchGate({
      content: args.content, source: args.source,
      items: [{ key: 'a', premise: 'x', decisionIds: ['issue-comment-reply'] }],
    });
    // A 0 setting cannot drop the decision's own 0.20 floor, and 0.30 clears it.
    expect(relaxed.decided.get('a')).toEqual({ 'issue-comment-reply': 'none' });
    expect(mocks.decide).toHaveBeenLastCalledWith(expect.objectContaining({ minMargin: 0.2 }));
    withPolicy({ jevMode: 'prefer', jevMinMargin: 0.5 });
    const strict = await jevBatchGate({
      content: args.content, source: args.source,
      items: [{ key: 'a', premise: 'x', decisionIds: ['issue-comment-reply'] }],
    });
    expect(strict.decided.size).toBe(0);
    expect(mocks.decide).toHaveBeenLastCalledWith(expect.objectContaining({ minMargin: 0.5 }));
  });

  it('falls back to the chat model on an abstention, and skips with a reason under only', async () => {
    withPolicy({ jevMode: 'prefer' });
    mocks.decide.mockResolvedValue(abstained());
    expect(await runUntrustedContentAnalysis({ ...args, jev: jevPlan })).toMatchObject({ ok: true, providerId: 'local' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    withPolicy({ jevMode: 'only' });
    mocks.fetch.mockClear();
    const skipped = await runUntrustedContentAnalysis({ ...args, jev: jevPlan });
    expect(skipped).toMatchObject({ ok: false, code: 'untrusted-content-jev-abstained' });
    // NOT coerced into `defer` — a skip has to stay distinguishable from a
    // verdict, or "cannot tell" silently becomes a decision nobody made.
    expect(skipped.value).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('takes the chat path untouched when the feature is off, and measures without changing the answer', async () => {
    withPolicy({ jevMode: 'off' });
    mocks.feature.mockResolvedValue(false);
    expect(await runUntrustedContentAnalysis({ ...args, jev: jevPlan })).toMatchObject({ ok: true, providerId: 'local' });
    expect(mocks.decide).not.toHaveBeenCalled();
    await expect(readFile(shadowFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // Feature on, mode off: the chat model still answers, and the scorer's
    // discarded verdict is folded into counters afterwards.
    mocks.feature.mockResolvedValue(true);
    mocks.decide.mockResolvedValue(chose('forge-maintenance-disposition', 'defer', 0.9));
    const shadowed = await runUntrustedContentAnalysis({ ...args, jev: jevPlan });
    expect(shadowed).toMatchObject({ ok: true, providerId: 'local', value: { disposition: 'defer' } });
    expect(shadowed.via).toBeUndefined();
    expect(mocks.decide).toHaveBeenCalledTimes(1);
    expect((await readShadow()).decisions['forge-maintenance-disposition'])
      .toMatchObject({ observed: 1, decided: 1, compared: 1, agreed: 1 });
  });

  it('records counts only — never a premise, a body or a choice tied to one', async () => {
    withPolicy({ jevMode: 'off' });
    mocks.decide.mockResolvedValue(chose('forge-maintenance-disposition', 'inspect-trusted-change', 0.9));
    await runUntrustedContentAnalysis({
      ...args,
      content: 'Example discussion with a distinctive marker phrase.',
      jev: {
        ...jevPlan,
        decisions: [{ id: 'forge-maintenance-disposition', premise: 'Example discussion with a distinctive marker phrase.' }],
      },
    });
    const serialized = await readFile(shadowFile, 'utf8');
    expect(serialized).not.toContain('distinctive marker phrase');
    // Neither side's verdict is kept — only that they differed. A stored
    // `inspect-trusted-change` would say which discussions a local scorer was
    // willing to release, which is a claim about the content itself.
    expect(serialized).not.toContain('inspect-trusted-change');
    expect(serialized).not.toContain('defer');
    // The chat model said `defer` and the scorer said `inspect-trusted-change`:
    // counted as a disagreement, with neither verdict retained.
    expect(JSON.parse(serialized).decisions['forge-maintenance-disposition']).toMatchObject({ compared: 1, agreed: 0 });
  });

  it('resolves only the batch items the scorer settled, and measures the rest against the chat answer', async () => {
    withPolicy({ jevMode: 'prefer' });
    const items = [
      { key: 'a', premise: 'first', decisionIds: ['issue-comment-reply'] },
      { key: 'b', premise: 'second', decisionIds: ['issue-comment-reply'] },
    ];
    mocks.decide
      .mockResolvedValueOnce(chose('issue-comment-reply', 'none', 0.9))
      .mockResolvedValueOnce(abstained());
    const gate = await jevBatchGate({ content: args.content, source: args.source, items });
    expect([...gate.decided.keys()]).toEqual(['a']);
    expect(gate.pending.map((item) => item.key)).toEqual(['b']);
    expect(gate.skipped).toEqual([]);
    await gate.measure({ b: { 'issue-comment-reply': 'reply' } });
    // Two observations, one abstention, and only `b` had a chat verdict to be
    // compared against — `a` never woke the model.
    expect((await readShadow()).decisions['issue-comment-reply'])
      .toMatchObject({ observed: 2, decided: 1, abstained: 1, compared: 0 });
  });

  it('falls through rather than returning a value the caller contract rejects', async () => {
    withPolicy({ jevMode: 'prefer' });
    mocks.decide.mockResolvedValue(chose('forge-maintenance-disposition', 'defer', 0.9));
    const result = await runUntrustedContentAnalysis({
      ...args,
      // A plan whose projection does not satisfy the caller's own schema.
      jev: { ...jevPlan, toValue: () => ({ disposition: 'defer' }) },
    });
    expect(result).toMatchObject({ ok: true, providerId: 'local' });
    expect(result.via).toBeUndefined();
  });
});

it('announces aggregate counters only after the durable observation write', async () => {
  const snapshots = [];
  const changed = payload => snapshots.push({ payload, read: readShadow() });
  jevEvents.on('stats', changed);
  try {
    await recordJevObservations({ decisionId: 'scope-adherence', kind: 'decided', agreed: true });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payload).toEqual({});
    expect((await snapshots[0].read).decisions['scope-adherence']).toMatchObject({ observed: 1, agreed: 1 });
    await recordJevObservations({ decisionId: 'unknown-decision', kind: 'decided' });
    expect(snapshots).toHaveLength(1);
  } finally {
    jevEvents.off('stats', changed);
  }
});

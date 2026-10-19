import { describe, it, expect, vi } from 'vitest';
import { recordAuditQuality, enrichAppsWithQuality, readRecentAuditSlices, AUDIT_SLICE_HISTORY_RUNS } from './appQuality.js';
import { AUDIT_DEFINITIONS } from '../lib/auditCatalog.js';
import { AUDIT_DISCOVERY, auditQualityInstructions, parseAuditQualityReport, parseRecommendedAudits, summarizeAppQuality, AUDIT_FRESHNESS_MS, buildAppQualityHistory, dailyQualityRecords, numericQualityReport, parseAuditSlice, QUALITY_WINDOW_RUNS } from '../lib/auditQuality.js';

const report = (overrides = {}) => ({ version: 1, category: 'better-complexity', score: 35, worstSeverity: 8,
  coverage: 'broad', confidence: 'high', summary: 'The checkout has a major branching hotspot in the job dispatcher.', scannedFiles: 100, totalFiles: 100, ...overrides });
// The v2 shape (#12076): the agent names the slice it read and rates only that.
const sliceReport = (overrides = {}) => ({ version: 2, category: 'better-complexity', slice: 'server/services', sliceScore: 35, worstSeverity: 8,
  coverage: 'broad', confidence: 'high', summary: 'The job dispatcher has a major branching hotspot.', scannedFiles: 100, totalFiles: 100, ...overrides });
const sentinel = value => `Completed audit.\nQUALITY_AUDIT_JSON: ${JSON.stringify(value)}\n`;
const task = { metadata: { app: 'portos-default' } };
const assessedAt = '2026-09-10T00:00:00Z';

// Unique regression: audits must persist a validated, app-scoped measurement
// without turning a missing/malformed report into a perfect score.
describe('scheduled audit measurement workflow', () => {
  it('covers every scheduled audit lens with a discovery strategy and score contract', () => {
    expect(Object.keys(AUDIT_DISCOVERY).sort()).toEqual(Object.keys(AUDIT_DEFINITIONS).sort());
    for (const category of Object.keys(AUDIT_DEFINITIONS)) {
      expect(auditQualityInstructions(category)).toContain(AUDIT_DISCOVERY[category]);
      expect(auditQualityInstructions(category)).toContain(`"category":"${category}"`);
    }
    expect(auditQualityInstructions('claim-issue')).toBe('');
    expect(auditQualityInstructions('react-lifecycle')).toContain('"category":"ui-lifecycle"');
  });

  it('accepts the structured sentinel envelope and uses server-owned app, category and run provenance', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ensureSchema = vi.fn();
    await expect(recordAuditQuality({ task, taskType: 'better-complexity', agentId: 'agent-1', workspacePath: '/repo', success: true, assessedAt }, {
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ summary: sentinel(report()), payload: null })), query, ensureSchema,
    })).resolves.toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['portos-default', 'better-complexity', 'agent-1', assessedAt, JSON.stringify(report()), null]);

  });

  it('records an in-flight task under the current UI lifecycle category', async () => {
    const legacyReport = report({ category: 'react-lifecycle', score: 73 });
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(recordAuditQuality({ task, taskType: 'react-lifecycle', agentId: 'agent-legacy', workspacePath: '/repo', success: true, assessedAt }, {
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ summary: sentinel(legacyReport), payload: null })),
      query,
      ensureSchema: vi.fn(),
    })).resolves.toBe(true);
    expect(query.mock.calls[0][1]).toEqual([
      'portos-default', 'ui-lifecycle', 'agent-legacy', assessedAt,
      JSON.stringify({ ...legacyReport, category: 'ui-lifecycle' }), null,
    ]);
  });

  it('rejects malformed, cross-category, duplicate and dishonest coverage reports and failed runs without writing', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn();
    const run = { task, taskType: 'better-complexity', agentId: 'agent-1', workspacePath: '/repo', success: true, assessedAt };
    for (const contents of ['', sentinel(report({ score: 101 })), sentinel(report({ score: '35' })), sentinel(report({ category: 'security' })), sentinel(report({ scannedFiles: 3, coverage: 'partial', totalFiles: 2 })), sentinel(report({ coverage: 'unavailable' })), sentinel(report()) + sentinel(report())]) {
      expect(await recordAuditQuality(run, { readFile: async () => contents, query })).toBe(false);
    }
    expect(await recordAuditQuality({ ...run, success: false }, { readFile: async () => sentinel(report()), query })).toBe(false);
    expect(warning).toHaveBeenCalledWith('⚠️ Audit quality report missing or invalid for agent-1 (better-complexity)');
    expect(await recordAuditQuality({ ...run, assessedAt: undefined }, { readFile: async () => sentinel(report()), query })).toBe(false);
    expect(warning).toHaveBeenLastCalledWith('⚠️ Audit quality skipped for agent-1: no valid run start time');
    warning.mockRestore();
    expect(query).not.toHaveBeenCalled();
    expect(parseAuditQualityReport(sentinel(report({ score: 0 })), 'better-complexity')?.score).toBe(0);
  });

  // #12076: a run rates the slice it deep-reviewed; the category-wide claim is gone
  // from the prompt, and every stored v1 record stays readable beside v2 ones.
  it('asks for a named slice score, parses the v2 report, and still reads stored v1 reports', () => {
    const instructions = auditQualityInstructions('better-complexity');
    expect(instructions).toContain('"version":2');
    expect(instructions).toContain('"slice":"top-level paths or area deep-reviewed"');
    expect(instructions).toContain('"sliceScore":null');
    expect(instructions).not.toMatch(/score the category|assess the pre-fix codebase for this category/i);
    const v2 = parseAuditQualityReport(sentinel(sliceReport()), 'better-complexity');
    expect(v2).toEqual(sliceReport());
    expect(numericQualityReport(v2)).toEqual({ version: 1, category: 'better-complexity', score: 35, worstSeverity: 8, coverage: 'broad', confidence: 'high', scannedFiles: 100, totalFiles: 100 });
    expect(numericQualityReport(report())).toEqual(report());
    expect(numericQualityReport(sliceReport({ sliceScore: 0 })).score).toBe(0);
    for (const broken of [{ ...sliceReport(), slice: '  ' }, { ...sliceReport(), score: 35 }, sliceReport({ coverage: 'unavailable' }), sliceReport({ sliceScore: 101 })]) {
      expect(parseAuditQualityReport(sentinel(broken), 'better-complexity')).toBeNull();
    }
    expect(parseAuditQualityReport(sentinel(sliceReport({ scannedFiles: 59, totalFiles: 89 })), 'better-complexity')).toMatchObject({ coverage: 'partial', sliceScore: 35 });
  });

  // #12076: the dashboard figure is a server-derived rolling window, so one
  // run's slice pick no longer swings the category by 20 points.
  it('derives the category score from a confidence-weighted window of recent run scores and keeps the newest run as evidence', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const daysAgo = n => new Date(now - n * 86400000).toISOString();
    const run = (n, sliceScore, overrides = {}) => ({ category: 'security', agentId: `run-${n}`, assessedAt: daysAgo(n),
      report: sliceReport({ category: 'security', slice: `slice-${n}`, sliceScore, worstSeverity: 3, ...overrides }) });
    const records = [
      run(0, 60, { coverage: 'partial', worstSeverity: 9 }), // newest: provisional, so it is the evidence row but not in the window
      run(1, 80),
      run(2, 40, { confidence: 'medium' }), // half weight
      run(3, 90, { confidence: 'low' }), // never contributes
      { category: 'security', agentId: 'run-4', assessedAt: daysAgo(4), report: report({ category: 'security', score: 50, worstSeverity: 3 }) }, // a stored v1 run counts too
      run(5, 10, { worstSeverity: 7 }),
      run(6, 20),
      run(7, 100), // sixth qualifying run: outside the window
      run(40, 0), // older than the freshness window
    ];
    expect(QUALITY_WINDOW_RUNS).toBe(5);
    const quality = summarizeAppQuality(records, now);
    // (80·1 + 40·0.5 + 50·1 + 10·1 + 20·1) / 4.5
    expect(quality).toMatchObject({ score: 40, ratedCategories: 1 });
    expect(quality.categories.find(c => c.id === 'security')).toMatchObject({
      score: 40, runScore: 60, slice: 'slice-0', coverage: 'partial', worstSeverity: 9, agentId: 'run-0', stale: false,
      window: { runs: 5, worstSeverity: 7 },
    });
    // No qualifying run: the row shows the newest run's own score beside its evidence label, and does not contribute.
    const unqualified = summarizeAppQuality([run(3, 90, { confidence: 'low' }), run(40, 0)], now);
    expect(unqualified).toMatchObject({ score: null, ratedCategories: 0 });
    expect(unqualified.categories.find(c => c.id === 'security')).toMatchObject({ score: 90, runScore: 90, window: { runs: 0, worstSeverity: null } });
  });

  // #12090: the AUDIT_SLICE line is the lane's rotation record. A summary
  // without it still records the report (slice null, or the v2 report's slice).
  it('stores the AUDIT_SLICE line beside the report and reads the lane\'s recent slices back', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const run = { task, taskType: 'better-complexity', agentId: 'agent-1', workspacePath: '/repo', success: true, assessedAt };
    const withLine = `Reviewed the dispatcher.\nAUDIT_SLICE:  server/services, server/lib/dispatch  \n${sentinel(report())}`;
    expect(await recordAuditQuality(run, { readFile: async () => withLine, query, ensureSchema: vi.fn() })).toBe(true);
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO app_quality_measurements \(app_id, category, agent_id, assessed_at, report, slice\)/);
    expect(query.mock.calls[0][1][5]).toBe('server/services, server/lib/dispatch');
    expect(await recordAuditQuality(run, { readFile: async () => sentinel(sliceReport()), query, ensureSchema: vi.fn() })).toBe(true);
    expect(query.mock.calls[1][1][5]).toBe('server/services');
    expect(parseAuditSlice('AUDIT_SLICE:   \nAUDIT_SLICE: late')).toBeNull();
    expect(parseAuditSlice(`AUDIT_SLICE: ${'x'.repeat(600)}`)).toHaveLength(500);
    expect(parseAuditSlice(null)).toBeNull();

    const read = vi.fn().mockResolvedValue({ rows: [{ assessed_at: new Date('2026-09-10T10:00:00Z'), slice: 'server/services' }] });
    expect(await readRecentAuditSlices('portos-default', 'react-lifecycle', { query: read })).toEqual([{ assessedAt: '2026-09-10T10:00:00.000Z', slice: 'server/services' }]);
    expect(read.mock.calls[0][0]).toMatch(/slice IS NOT NULL/);
    expect(read.mock.calls[0][1]).toEqual(['portos-default', 'ui-lifecycle', AUDIT_SLICE_HISTORY_RUNS]);
  });

  // The same run reaches the window as the local row and again through the
  // day-only release snapshot it was published into; it must count once.
  it('collapses each category to its newest run per UTC day before rolling', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const local = { category: 'security', agentId: 'run-a', assessedAt: '2026-09-10T10:00:00Z', report: sliceReport({ category: 'security', sliceScore: 80 }) };
    const release = { category: 'security', measurementId: 'f'.repeat(64), assessedAt: '2026-09-10T00:00:00.000Z', sourcePeerName: 'Release snapshot', report: report({ category: 'security', score: 80 }) };
    const older = { category: 'react-lifecycle', agentId: 'run-b', assessedAt: '2026-09-08T10:00:00Z', report: sliceReport({ category: 'react-lifecycle', sliceScore: 20 }) };
    const daily = dailyQualityRecords([release, local, older, { ...local, agentId: 'run-c', assessedAt: '2026-09-08T09:00:00Z', report: sliceReport({ category: 'security', sliceScore: 20 }) }]);
    expect(daily.map(r => [r.category, r.agentId])).toEqual([['security', 'run-c'], ['ui-lifecycle', 'run-b'], ['security', 'run-a']]);
    expect(summarizeAppQuality(daily, now).categories.find(c => c.id === 'security')).toMatchObject({ score: 50, window: { runs: 2 } });
  });

  // Unique regression: a "broad" claim over a partial scan (5907/8923 files) used to drop the whole run's measurement.
  it('records a broad claim over a partial scan as partial coverage instead of discarding it', () => {
    const parsed = parseAuditQualityReport(sentinel(report({ scannedFiles: 59, totalFiles: 89 })), 'better-complexity');
    expect(parsed).toMatchObject({ coverage: 'partial', score: 35, scannedFiles: 59, totalFiles: 89 });
  });

  it('excludes stale, partial, low-confidence and inapplicable assessments while retaining their breakdown', () => {
    const now = Date.now();
    const records = [
      ['better-complexity', 0, 'broad', 'high', now],
      ['code-quality', 80, 'broad', 'medium', now],
      ['security', 100, 'partial', 'high', now],
      ['ux', 100, 'broad', 'high', now - AUDIT_FRESHNESS_MS - 1],
      ['typing', null, 'not-applicable', 'low', now],
      ['performance', 100, 'broad', 'low', now],
    ].map(([category, score, coverage, confidence, date]) => ({ category, report: report({ category, score, coverage, confidence }), assessedAt: new Date(date).toISOString() }));
    const quality = summarizeAppQuality(records, now);
    expect(quality).toMatchObject({ score: 40, ratedCategories: 2, totalCategories: Object.keys(AUDIT_DEFINITIONS).length });
    expect(quality.categories.find(c => c.id === 'ux')).toMatchObject({ score: 100, stale: true });
    expect(summarizeAppQuality().score).toBeNull();
  });

  // The regression: a backend API was reported as "2 of 30 categories" because
  // seven UI audits it cannot have findings for sat in the denominator.
  it('drops categories that cannot apply from the denominator, unless rated evidence says they do', () => {
    const now = Date.now();
    const records = [
      ['code-quality', 80, 'broad', 'high'],
      ['typing', null, 'not-applicable', 'low'],
      ['mobile-responsive', 60, 'broad', 'high'],
    ].map(([category, score, coverage, confidence]) => ({ category, report: report({ category, score, coverage, confidence }), assessedAt: new Date(now).toISOString() }));
    const quality = summarizeAppQuality(records, now, { inapplicable: { accessibility: 'no user interface found', 'mobile-responsive': 'no user interface found' } });
    const byId = Object.fromEntries(quality.categories.map(c => [c.id, c]));
    expect(byId.accessibility).toMatchObject({ applicable: false, inapplicableReason: 'no user interface found' });
    expect(byId.typing).toMatchObject({ applicable: false, inapplicableReason: expect.stringMatching(/not applicable/) });
    // Detected as UI-less, but a fresh broad assessment exists: it counts.
    expect(byId['mobile-responsive']).toMatchObject({ applicable: true, inapplicableReason: null });
    expect(quality.applicableCategories).toBe(Object.keys(AUDIT_DEFINITIONS).length - 2);
    expect(quality.score).toBe(70);
  });

  it('surfaces previously stored lifecycle scores under the renamed category', () => {
    const now = Date.now();
    const legacy = {
      category: 'react-lifecycle',
      assessedAt: new Date(now).toISOString(),
      report: report({ category: 'react-lifecycle', score: 73 }),
    };

    expect(summarizeAppQuality([legacy], now).categories.find(category => category.id === 'ui-lifecycle'))
      .toMatchObject({ score: 73, coverage: 'broad', stale: false });
    expect(buildAppQualityHistory([legacy], 1, now).points.at(-1).categories['ui-lifecycle'])
      .toMatchObject({ score: 73, coverage: 'broad', confidence: 'high' });
  });

  it('makes database unavailability explicit without failing app management', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [app] = await enrichAppsWithQuality([{ id: 'app' }], { query: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(app.quality).toMatchObject({ unavailable: true, score: null });
    log.mockRestore();
  });

  // The dispatch gate reads only this install's rulings; a peer's describes a
  // different checkout, so the Quality tab must not hide the category on it.
  it('does not let a peer\'s not-applicable ruling mark a category inapplicable here', () => {
    const now = Date.now();
    const peerRow = { category: 'ux', sourcePeerId: 'peer-a', sourcePeerName: 'Peer A', assessedAt: new Date(now).toISOString(),
      report: report({ category: 'ux', score: null, coverage: 'not-applicable', confidence: 'low' }) };
    const localRow = { ...peerRow, sourcePeerId: undefined, sourcePeerName: undefined };
    expect(summarizeAppQuality([peerRow], now).categories.find(c => c.id === 'ux').applicable).toBe(true);
    expect(summarizeAppQuality([localRow], now).categories.find(c => c.id === 'ux').applicable).toBe(false);
  });

  // The detail read feeds the repository scan into the summary; a failing scan
  // must cost only the applicability, never the whole quality read.
  it('folds the repository-scan verdicts into the summary, and ignores a scan that fails', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const [scanned] = await enrichAppsWithQuality([{ id: 'app' }], {
      query, resolveApplicability: async () => ({ accessibility: 'no user interface found' }),
    });
    expect(scanned.quality.categories.find(c => c.id === 'accessibility')).toMatchObject({ applicable: false, inapplicableReason: 'no user interface found' });
    expect(scanned.quality.applicableCategories).toBe(Object.keys(AUDIT_DEFINITIONS).length - 1);
    const [failed] = await enrichAppsWithQuality([{ id: 'app' }], {
      query, resolveApplicability: async () => { throw new Error('git unavailable'); },
    });
    expect(failed.quality.applicableCategories).toBe(Object.keys(AUDIT_DEFINITIONS).length);
  });
});

it('retains historical scores without hindsight, expires old evidence, and rolls each day the same way as the live summary', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const rows = [
    { category: 'better-complexity', assessedAt: '2026-08-01T12:00:00Z', report: report({ score: 20 }) },
    { category: 'better-complexity', assessedAt: '2026-09-08T12:00:00Z', report: sliceReport({ sliceScore: 30 }) },
    { category: 'better-complexity', assessedAt: '2026-09-09T12:00:00Z', report: report({ score: 70 }) },
    { category: 'security', assessedAt: '2026-09-10T10:00:00Z', report: report({ category: 'security', score: 90 }) },
  ];
  const { points } = buildAppQualityHistory(rows, 90, now);
  expect(points.find(p => p.date === '2026-07-31').score).toBeNull();
  expect(points.find(p => p.date === '2026-08-01')).toMatchObject({ score: 20, ratedCategories: 1 });
  expect(points.find(p => p.date === '2026-09-01').score).toBeNull();
  expect(points.find(p => p.date === '2026-09-08')).toMatchObject({ score: 30, ratedCategories: 1 });
  // 09-09 averages the two fresh runs (the 08-01 run has expired); the next day adds security.
  expect(points.find(p => p.date === '2026-09-09')).toMatchObject({ score: 50, ratedCategories: 1 });
  expect(points.at(-1)).toMatchObject({ score: 70, ratedCategories: 2 });
  expect(points.at(-1).categories['better-complexity']).toMatchObject({ score: 50, coverage: 'broad', confidence: 'high' });
});


it('records honest unscored partial Deep evidence without inventing a score or contributing to overall quality', async () => {
  const partial = report({ category: 'observability', score: null, worstSeverity: 0, coverage: 'partial', confidence: 'low',
    summary: '169 assigned files signal-scanned; substantive review incomplete and category score unavailable.', scannedFiles: 169, totalFiles: 10636 });
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const run = { task: { ...task, metadata: { ...task.metadata, auditDepth: 'deep' } }, taskType: 'observability',
    agentId: 'agent-partial', workspacePath: '/repo', success: true, assessedAt };
  expect(await recordAuditQuality(run, { readFile: async () => sentinel(partial), query, ensureSchema: vi.fn() })).toBe(true);
  expect(JSON.parse(query.mock.calls[0][1][4])).toEqual(partial);
  const summary = summarizeAppQuality([{ category: 'observability', report: partial, assessedAt, agentId: 'agent-partial' }], Date.parse(assessedAt));
  expect(summary).toMatchObject({ score: null, ratedCategories: 0 });
  expect(summary.categories.find(category => category.id === 'observability')).toMatchObject({ score: null, coverage: 'partial' });
  expect(parseAuditQualityReport(sentinel({ ...partial, coverage: 'broad', scannedFiles: 10636 }), 'observability')).toBeNull();
  expect(parseAuditQualityReport(sentinel({ ...partial, scannedFiles: 0 }), 'observability')).toBeNull();
  expect(auditQualityInstructions('observability')).toContain('For partial coverage, use sliceScore:null');
});

// The code-quality lane's triage output (#12085): a ranked list under a
// `Recommended next audits` heading in the completion summary.
describe('parseRecommendedAudits', () => {
  it('reads the ranked list under the heading, stripping markers and stopping at the block end', () => {
    const summary = [
      'Reviewed server/routes. Filed 2 issues.',
      '## Recommended next audits',
      '1. better-structural-drift — three hand-synced registries drifted: server/lib/navManifest.js, client/src/lib/navPresentation.js',
      '2) better-runtime-safety — floating promises in socket handlers: server/services/sockets/',
      '- error-handling — unhandled fetch failures: client/src/services/api.js',
      '4. extra-lane — should be ignored beyond three',
      '',
      'QUALITY_AUDIT_JSON: {"version":1}',
    ].join('\n');
    expect(parseRecommendedAudits(summary)).toEqual([
      'better-structural-drift — three hand-synced registries drifted: server/lib/navManifest.js, client/src/lib/navPresentation.js',
      'better-runtime-safety — floating promises in socket handlers: server/services/sockets/',
      'error-handling — unhandled fetch failures: client/src/services/api.js',
    ]);
  });

  it('accepts a bold or plain heading and stops at the next heading', () => {
    const summary = '**Recommended next audits**\n1. ux — buried primary action: client/src/pages/Apps.jsx\n## Next\n2. privacy — not part of the block';
    expect(parseRecommendedAudits(summary)).toEqual(['ux — buried primary action: client/src/pages/Apps.jsx']);
  });

  it('returns an empty list for a summary with no block, a heading with no list, or a non-string', () => {
    expect(parseRecommendedAudits('Reviewed and filed nothing.')).toEqual([]);
    expect(parseRecommendedAudits('## Recommended next audits\n\n1. late — after a blank line')).toEqual([]);
    expect(parseRecommendedAudits(null)).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { recordAuditQuality, enrichAppsWithQuality, getAppQualityHistory, readRecentAuditSlices, AUDIT_SLICE_HISTORY_RUNS } from './appQuality.js';
import { AUDIT_DEFINITIONS } from '../lib/auditCatalog.js';
import { AUDIT_DISCOVERY, auditQualityInstructions, parseAuditQualityReport, parseRecommendedAudits, summarizeAppQuality, AUDIT_FRESHNESS_MS, buildAppQualityHistory, dailyQualityRecords, numericQualityReport, parseAuditSlice, QUALITY_WINDOW_RUNS, QUALITY_HEALTHY_THRESHOLD } from '../lib/auditQuality.js';
import { buildQualitySnapshot, exportPortosQuality, readQualityRecords } from './appQualityFederation.js';
import { classifyQualitySnapshot, serializeQualitySnapshot } from './appQualitySnapshotFormat.js';

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
    expect(auditQualityInstructions('code-quality')).toContain('Proportionality check');
    expect(auditQualityInstructions('react-lifecycle')).toContain('"category":"ui-lifecycle"');
  });

  // Unique regression: the owner's stated deployment model reaches every audit,
  // and an app without one falls back to the repository's docs, never to a
  // hardcoded single-user assumption.
  it('calibrates reachability against the app deployment model', () => {
    const stated = auditQualityInstructions('app-bugs', { deploymentModel: 'Public SaaS, many tenants.\nTwo regions.' });
    expect(stated).toContain('> Public SaaS, many tenants.\n> Two regions.');
    expect(stated).toContain('the same action fired twice');
    const fallback = auditQualityInstructions('data-integrity', { deploymentModel: '   ' });
    expect(fallback).toContain("Take the deployment model from the app's own requirements: its PRD, spec");
    expect(auditQualityInstructions('security')).toContain('Reachability check');
  });

  it('persists Design screenshot coverage through the existing assessment and slice history contract', async () => {
    const designReport = sliceReport({ category: 'design', slice: 'client/src/components/media',
      sliceScore: null, coverage: 'unavailable', confidence: 'low', worstSeverity: 0,
      summary: 'Screenshot inspection blocked; visual coverage untested.', scannedFiles: 0, totalFiles: 3 });
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const summary = `${sentinel(designReport)}AUDIT_SLICE: client/src/components/media`;
    await expect(recordAuditQuality({ task, taskType: 'design', agentId: 'design-run',
      workspacePath: '/repo', success: true, assessedAt }, {
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ summary, payload: null })),
      query, ensureSchema: vi.fn(),
    })).resolves.toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['portos-default', 'design', 'design-run',
      assessedAt, JSON.stringify(designReport), 'client/src/components/media']);
  });

  it('accepts the structured sentinel envelope and uses server-owned app, category and run provenance', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ensureSchema = vi.fn();
    await expect(recordAuditQuality({ task, taskType: 'better-complexity', agentId: 'agent-1', workspacePath: '/repo', success: true, assessedAt }, {
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ summary: sentinel(report()), payload: null })), query, ensureSchema,
    })).resolves.toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['portos-default', 'better-complexity', 'agent-1', assessedAt, JSON.stringify(report()), null]);

  });

  it('strips nested protocol lines before storing a quality assessment', async () => {
    const assessment = sliceReport({ summary: 'The dispatcher has a branching hotspot.\r\n  AUDIT_SLICE: incorrect slice\n\tQUALITY_AUDIT_JSON: {}\nThe retry path adds another branch.' });
    const summary = `${sentinel(assessment)}AUDIT_SLICE: server/services`;
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(recordAuditQuality({ task, taskType: 'better-complexity', agentId: 'mixed-summary',
      workspacePath: '/repo', success: true, assessedAt }, {
      readFile: async () => JSON.stringify({ summary }), query, ensureSchema: vi.fn(),
    })).resolves.toBe(true);
    expect(query.mock.calls[0][1].slice(4)).toEqual([
      JSON.stringify({ ...assessment, summary: 'The dispatcher has a branching hotspot.\nThe retry path adds another branch.' }),
      'server/services',
    ]);
  });

  it('rejects reports with only protocol lines in the assessment summary', () => {
    const markerOnly = report({ summary: '  AUDIT_SLICE: server/services\r\n\tQUALITY_AUDIT_JSON:\n ' });
    expect(parseAuditQualityReport(sentinel(markerOnly), 'better-complexity')).toBeNull();
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
      run(5, 10, { worstSeverity: 7 }), // fourth qualifying run: outside the window
      run(40, 0), // older than the freshness window
    ];
    expect(QUALITY_WINDOW_RUNS).toBe(3);
    const quality = summarizeAppQuality(records, now);
    // Confidence weights (1, 0.5, 1) each times 0.5^(ageDays/7).
    expect(quality).toMatchObject({ score: 62, ratedCategories: 1 });
    expect(quality.categories.find(c => c.id === 'security')).toMatchObject({
      score: 62, runScore: 60, slice: 'slice-0', coverage: 'partial', worstSeverity: 9, agentId: 'run-0', stale: false,
      window: { runs: 3, worstSeverity: 3 },
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

    const read = vi.fn().mockResolvedValue({ rows: [{ assessed_at: new Date('2026-09-10T10:00:00Z'), slice: 'server/services', report: { version: 2, sliceScore: 62, worstSeverity: 5 } },
      { assessed_at: new Date('2026-09-09T10:00:00Z'), slice: 'server/routes', report: { version: 1, score: 90, worstSeverity: 0 } }] });
    expect(await readRecentAuditSlices('portos-default', 'react-lifecycle', { query: read })).toEqual([{ assessedAt: '2026-09-10T10:00:00.000Z', slice: 'server/services', sliceScore: 62, worstSeverity: 5 },
      { assessedAt: '2026-09-09T10:00:00.000Z', slice: 'server/routes', sliceScore: 90, worstSeverity: 0 }]);
    expect(read.mock.calls[0][0]).toMatch(/slice IS NOT NULL/);
    expect(read.mock.calls[0][1]).toEqual(['portos-default', ['ui-lifecycle', 'react-lifecycle'], AUDIT_SLICE_HISTORY_RUNS]);
    await readRecentAuditSlices('portos-default', 'ui-runtime-bugs', { query: read });
    expect(read.mock.calls[1][1][1]).toEqual(['ui-runtime-bugs', 'app-bugs', 'ui-bugs', 'console-errors', 'ui-lifecycle', 'react-lifecycle']);
  });

  it('decays older runs with a 7-day half-life alongside confidence weights', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const mk = (daysAgo, score, agentId) => ({ category: 'security', agentId, assessedAt: new Date(now - daysAgo * 86400000).toISOString(),
      report: { version: 2, category: 'security', slice: `slice-${agentId}`, sliceScore: score, worstSeverity: 1, coverage: 'broad', confidence: 'high', summary: 'x', scannedFiles: 1, totalFiles: 1 } });
    const records = [mk(0, 90, 'a'), mk(7, 30, 'b')];
    // weights 1 and 0.5 → (90 + 15) / 1.5 = 70
    expect(summarizeAppQuality(records, now).categories.find(c => c.id === 'security').score).toBe(70);
  });

  // The same run reaches the window as the local row and again through the
  // day-only release snapshot it was published into; it must count once.
  it('deduplicates a run against its same-day release snapshot without dropping distinct same-day local runs', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const local = { category: 'security', agentId: 'run-a', assessedAt: '2026-09-10T10:00:00Z', report: sliceReport({ category: 'security', slice: 'server/services', sliceScore: 80 }) };
    const release = { category: 'security', measurementId: 'f'.repeat(64), assessedAt: '2026-09-10T00:00:00.000Z', sourcePeerName: 'Release snapshot', report: report({ category: 'security', score: 80 }) };
    const older = { category: 'react-lifecycle', agentId: 'run-b', assessedAt: '2026-09-08T10:00:00Z', report: sliceReport({ category: 'react-lifecycle', slice: 'client/src/hooks', sliceScore: 20 }) };
    const daily = dailyQualityRecords([release, local, older, { ...local, agentId: 'run-c', assessedAt: '2026-09-08T09:00:00Z', report: sliceReport({ category: 'security', slice: 'server/lib', sliceScore: 20 }) }]);
    expect(daily.map(r => [r.category, r.agentId])).toEqual([['security', 'run-c'], ['ui-lifecycle', 'run-b'], ['security', 'run-a']]);
    expect(summarizeAppQuality(daily, now).categories.find(c => c.id === 'security')).toMatchObject({ score: 53, window: { runs: 2 } });
  });

  // #18216: same-day slice re-verification and same-day partial/low-confidence
  // runs must not collapse distinct local runs before selectCategoryWindow().
  it('keeps same-day slice re-verifications so older pre-fix runs stay superseded across live summary and history', async () => {
    const now = Date.parse('2026-09-10T16:00:00Z');
    const day1 = { app_id: 'portos-default', category: 'security', agent_id: 'run-day1-a', assessed_at: '2026-09-09T10:00:00Z',
      slice: 'server/services', report: sliceReport({ category: 'security', slice: 'server/services', sliceScore: 55, worstSeverity: 8 }) };
    const day2a = { app_id: 'portos-default', category: 'security', agent_id: 'run-day2-a', assessed_at: '2026-09-10T09:00:00Z',
      slice: 'server/services', report: sliceReport({ category: 'security', slice: 'server/services', sliceScore: 95, worstSeverity: 1 }) };
    const day2b = { app_id: 'portos-default', category: 'security', agent_id: 'run-day2-b', assessed_at: '2026-09-10T15:00:00Z',
      slice: 'server/lib', report: sliceReport({ category: 'security', slice: 'server/lib', sliceScore: 88, worstSeverity: 1 }) };
    const dailyRows = [day2b, day1];
    const allRows = [day2b, day2a, day1];
    const query = vi.fn(async sql => ({ rows: /rank\(\) OVER/i.test(sql) ? dailyRows : allRows }));
    const getOriginInfo = async () => ({ host: 'github.com', fullName: 'owner/app' });
    const snapshot = await buildQualitySnapshot({ id: 'portos-default', repoPath: '/repo' }, null, { now, query, getOriginInfo });
    expect(snapshot.measurements.map(m => m.report.score)).toEqual([88, 55]);
    expect(JSON.stringify(snapshot)).not.toMatch(/slice|server\/services|server\/lib/i);

    const peer = { id: 'peer-a', instanceId: 'instance-a', enabled: true, address: '192.0.2.1', port: 5555 };
    const exported = await exportPortosQuality(peer.instanceId, 30, { now, query, getOriginInfo, getPeers: async () => [peer] });
    expect(exported.measurements.map(m => m.report.score)).toEqual([88, 55]);
    expect(JSON.stringify(exported)).not.toMatch(/slice|server\/services|server\/lib/i);

    const snapshotFile = serializeQualitySnapshot(snapshot.repository,
      snapshot.measurements.map(m => ({ ...m.report, assessedAt: m.assessedAt, measurementId: m.measurementId })));
    const readFile = async () => snapshotFile;
    const deps = { now, query, readFile, getOriginInfo, getPeers: async () => [] };
    const [enriched] = await enrichAppsWithQuality([{ id: 'portos-default', repoPath: '/repo' }], deps);
    const sec = enriched.quality.categories.find(c => c.id === 'security');
    expect(sec).toMatchObject({ score: 91, runScore: 88, slice: 'server/lib', window: { runs: 2, worstSeverity: 1 } });

    const history = await getAppQualityHistory({ id: 'portos-default', repoPath: '/repo' }, 30, deps);
    expect(history.points.at(-1)).toMatchObject({ score: 91, ratedCategories: 1, categories: { security: { score: 91, coverage: 'broad' } } });
  });

  it('preserves same-day qualifying broad runs when followed by a partial or low-confidence run', async () => {
    const now = Date.parse('2026-09-10T16:00:00Z');
    const secBroad = { app_id: 'portos-default', category: 'security', agent_id: 'sec-broad', assessed_at: '2026-09-10T09:00:00Z',
      slice: 'server/services', report: sliceReport({ category: 'security', slice: 'server/services', sliceScore: 90, worstSeverity: 1 }) };
    const secPartial = { app_id: 'portos-default', category: 'security', agent_id: 'sec-partial', assessed_at: '2026-09-10T15:00:00Z',
      slice: 'server/lib', report: sliceReport({ category: 'security', slice: 'server/lib', sliceScore: 40, worstSeverity: 7, coverage: 'partial', scannedFiles: 10, totalFiles: 100 }) };
    const privBroad = { app_id: 'portos-default', category: 'privacy', agent_id: 'priv-broad', assessed_at: '2026-09-10T09:00:00Z',
      slice: null, report: report({ category: 'privacy', score: 90, worstSeverity: 1 }) };
    const privLow = { app_id: 'portos-default', category: 'privacy', agent_id: 'priv-low', assessed_at: '2026-09-10T15:00:00Z',
      slice: null, report: report({ category: 'privacy', score: 30, worstSeverity: 6, confidence: 'low' }) };
    const rows = [secPartial, secBroad, privLow, privBroad];
    const query = vi.fn(async sql => ({ rows: /rank\(\) OVER/i.test(sql) ? [secBroad, privBroad] : rows }));
    const getOriginInfo = async () => ({ host: 'github.com', fullName: 'owner/app' });
    const snapshot = await buildQualitySnapshot({ id: 'portos-default', repoPath: '/repo' }, null, { now, query, getOriginInfo });
    const snapshotFile = serializeQualitySnapshot(snapshot.repository,
      snapshot.measurements.map(m => ({ ...m.report, assessedAt: m.assessedAt, measurementId: m.measurementId })));
    const deps = { now, query, readFile: async () => snapshotFile, getOriginInfo, getPeers: async () => [] };

    const [enriched] = await enrichAppsWithQuality([{ id: 'portos-default', repoPath: '/repo' }], deps);
    expect(enriched.quality).toMatchObject({ score: 90, ratedCategories: 2 });
    expect(enriched.quality.categories.find(c => c.id === 'security')).toMatchObject({
      score: 90, runScore: 40, coverage: 'partial', worstSeverity: 7, slice: 'server/lib', agentId: 'sec-partial',
      window: { runs: 1, worstSeverity: 1 },
    });
    expect(enriched.quality.categories.find(c => c.id === 'privacy')).toMatchObject({
      score: 90, runScore: 30, coverage: 'broad', confidence: 'low', worstSeverity: 6, agentId: 'priv-low',
      window: { runs: 1, worstSeverity: 1 },
    });

    const history = await getAppQualityHistory({ id: 'portos-default', repoPath: '/repo' }, 30, deps);
    expect(history.points.at(-1)).toMatchObject({
      score: 90, ratedCategories: 2,
      categories: {
        security: { score: 90, coverage: 'partial', confidence: 'high' },
        privacy: { score: 90, coverage: 'broad', confidence: 'low' },
      },
    });
  });

  it('supersedes older pre-fix runs and older imported scores while preserving legacy local runs', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const daysAgo = n => new Date(now - n * 86400000).toISOString();
    const v2Run = (n, slice, sliceScore, extra = {}) => ({
      category: 'security', agentId: `run-${n}`, assessedAt: daysAgo(n),
      report: sliceReport({ category: 'security', slice, sliceScore, worstSeverity: 2, ...extra }),
    });
    const records = [
      // Partial re-audit on the same slice does NOT supersede an older qualifying run.
      v2Run(0, 'server/services/auth, server/lib/db.js', 95, { coverage: 'partial' }),
      // Post-fix qualifying re-audit with reordered, mixed-case, padded comma segments.
      v2Run(1, '  Server/Lib/Db.js , server/services/auth  ', 90),
      // Distinct slice keeps its place.
      v2Run(2, 'client/src/pages', 86),
      // Older pre-fix run on the same normalized slice is superseded.
      v2Run(3, 'server/services/auth, server/lib/db.js', 40, { worstSeverity: 8 }),
      // Older imported rows are displaced, but local slice-less evidence from a different day still counts.
      { category: 'security', agentId: 'peer-1', sourcePeerId: 'peer-a', assessedAt: daysAgo(4), report: report({ category: 'security', score: 88, worstSeverity: 2 }) },
      { category: 'security', sourcePeerName: 'Release snapshot', assessedAt: daysAgo(5), report: report({ category: 'security', score: 84, worstSeverity: 2 }) },
      { category: 'security', assessedAt: daysAgo(7), report: report({ category: 'security', score: 84, worstSeverity: 2 }) },
    ];
    const row = summarizeAppQuality(records, now).categories.find(c => c.id === 'security');
    expect(row.window).toEqual({ runs: 3, worstSeverity: 2 });
    expect(row.score).toBe(87);
  });

  it.each([
    ['./Server\\Services\\Foo.js/', 'server/services/foo.js, server/routes/foo.js', 1],
    ['server/lib, server/routes, server/services', 'server/services/foo.js, server/lib/db.js', 1],
    ['server/lib, server/routes/foo.js', 'server/routes/foo.js, server/lib', 1],
    ['server/lib-extra', 'server/lib', 2],
    ['server/lib/db.js', 'server/lib', 2],
    ['server/routes/foo.js, server/lib', 'server/services/foo.js, server/lib', 2],
  ])('compares qualifying canonical slices (%s versus %s)', (newerSlice, olderSlice, runs) => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const record = (slice, sliceScore, worstSeverity, assessedAt, coverage = 'broad') => ({
      category: 'security', assessedAt,
      report: sliceReport({ category: 'security', slice, sliceScore, worstSeverity, coverage }),
    });
    const row = summarizeAppQuality([
      record(olderSlice, 99, 0, '2026-09-10T11:00:00Z', 'partial'),
      record(newerSlice, 92, 1, '2026-09-09T12:00:00Z'),
      record(olderSlice, 50, 8, '2026-09-08T12:00:00Z'),
    ], now).categories.find(category => category.id === 'security');
    expect(row).toMatchObject(runs === 1
      ? { score: 92, window: { runs: 1, worstSeverity: 1 } }
      : { score: 72, window: { runs: 2, worstSeverity: 8 } });
  });

  it.each([
    [{ sourcePeerId: 'peer-a' }, '2026-09-10T09:00:00Z', false],
    [{ sourcePeerId: 'peer-a' }, '2026-09-10T10:00:00Z', false],
    [{}, '2026-09-10T13:00:00Z', false],
    [{ sourcePeerId: 'peer-a' }, '2026-09-10T13:00:00Z', true],
    [{ sourcePeerName: 'Release snapshot' }, '2026-09-10T13:00:00Z', true],
  ])('lets strictly newer imported evidence lead the same-day window (%j, %s)', (source, importedAt, leads) => {
    const now = Date.parse('2026-09-10T16:00:00Z');
    const local = { category: 'security', assessedAt: '2026-09-10T10:00:00Z',
      report: sliceReport({ category: 'security', sliceScore: 92, worstSeverity: 1 }) };
    const imported = { category: 'security', assessedAt: importedAt,
      report: report({ category: 'security', score: 50 }), ...source };
    const daily = dailyQualityRecords([local, imported]);
    const latest = leads ? imported : local;
    const expectedScore = leads ? 71 : 92;
    expect(summarizeAppQuality(daily, now).categories.find(c => c.id === 'security'))
      .toMatchObject({ assessedAt: latest.assessedAt, runScore: leads ? 50 : 92,
        sourcePeerId: latest.sourcePeerId ?? null, sourcePeerName: latest.sourcePeerName ?? null,
        score: expectedScore, window: { runs: leads ? 2 : 1, worstSeverity: leads ? 8 : 1 } });
    expect(buildAppQualityHistory(daily, 1, now).points[0].categories.security.score).toBe(expectedScore);

    // A partial local scan cannot displace a qualifying imported run.
    const partial = { ...local, report: { ...local.report, coverage: 'partial', scannedFiles: 50 } };
    expect(summarizeAppQuality(dailyQualityRecords([partial, imported]), now).categories.find(c => c.id === 'security'))
      .toMatchObject({ score: 50, window: { runs: 1, worstSeverity: 8 } });
  });

  it('uses newer imported evidence on another UTC day until a qualifying local re-audit supersedes it', () => {
    const now = Date.parse('2026-09-12T16:00:00Z');
    const local = { category: 'security', assessedAt: '2026-09-10T10:00:00Z',
      report: sliceReport({ category: 'security', sliceScore: 92, worstSeverity: 1 }) };
    const peer = { category: 'security', assessedAt: '2026-09-11T11:00:00Z',
      sourcePeerId: 'peer-a', report: report({ category: 'security', score: 50 }) };
    const fixed = { ...local, assessedAt: '2026-09-12T12:00:00Z', report: { ...local.report, sliceScore: 95 } };
    expect(summarizeAppQuality([local, peer], now).categories.find(c => c.id === 'security'))
      .toMatchObject({ score: 70, window: { runs: 2, worstSeverity: 8 } });
    expect(summarizeAppQuality([local, peer, fixed], now).categories.find(c => c.id === 'security'))
      .toMatchObject({ score: 95, window: { runs: 1, worstSeverity: 1 } });
  });

  it('isolates consolidated domain windows from pre-consolidation legacy member runs while preserving member history and legacy-only repos', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const daysAgo = n => new Date(now - n * 86400000).toISOString();
    const mk = (category, n, score, slice, overrides = {}) => ({
      category, agentId: `${category}-${n}`, assessedAt: daysAgo(n),
      report: sliceReport({ category, slice, sliceScore: score, worstSeverity: 2, ...overrides }),
    });

    // Domain has a fresh qualifying native run at day 3; older legacy member runs (days 5, 10)
    // are retired from the rolling window, while a newer legacy member run (day 1) stays eligible.
    const mixed = [
      mk('app-bugs', 1, 86, 'server/routes'),
      mk('ui-runtime-bugs', 3, 90, 'server/services'),
      mk('app-bugs', 5, 45, 'server/lib', { worstSeverity: 8 }),
      mk('ui-lifecycle', 10, 50, 'client/src/hooks', { worstSeverity: 7 }),
    ];
    const mixedRow = summarizeAppQuality(mixed, now).categories.find(c => c.id === 'ui-runtime-bugs');
    expect(mixedRow.window).toEqual({ runs: 2, worstSeverity: 2 });
    expect(mixedRow.score).toBeGreaterThanOrEqual(87);
    // UI member history still surfaces the retired legacy member runs.
    expect(mixedRow.members.find(m => m.id === 'ui-lifecycle')).toMatchObject({ score: 50, stale: false });
    expect(mixedRow.members.find(m => m.id === 'app-bugs')).toMatchObject({ score: 86, stale: false });

    // Legacy-only repo (and a partial/unqualified native run) keeps legacy member runs in the window.
    const legacyOnly = [
      mk('ui-runtime-bugs', 1, 92, 'server/services', { coverage: 'partial' }),
      mk('app-bugs', 5, 60, 'server/lib'),
      mk('ui-lifecycle', 8, 70, 'client/src/hooks'),
    ];
    const legacyRow = summarizeAppQuality(legacyOnly, now).categories.find(c => c.id === 'ui-runtime-bugs');
    expect(legacyRow.window.runs).toBe(2);
    expect(legacyRow.score).toBe(64);
  });

  it('selects local slice columns for superseding without leaking slice through federation v1 or .quality.json v3', async () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const dbRows = [
      { app_id: 'portos-default', category: 'security', agent_id: 'new-run', assessed_at: '2026-09-10T10:00:00Z',
        slice: 'server/services/auth', report: report({ category: 'security', score: 90, worstSeverity: 1 }) },
      { app_id: 'portos-default', category: 'security', agent_id: 'old-run', assessed_at: '2026-09-05T10:00:00Z',
        slice: 'Server/Services/Auth', report: report({ category: 'security', score: 40, worstSeverity: 8 }) },
    ];
    const query = vi.fn().mockResolvedValue({ rows: dbRows });
    const [enriched] = await enrichAppsWithQuality([{ id: 'portos-default' }], {
      now, query, getPeers: async () => [], readFile: async () => null,
    });
    expect(query.mock.calls[0][0]).toMatch(/SELECT app_id, category, agent_id, assessed_at, report, slice/);
    expect(enriched.quality.categories.find(c => c.id === 'security')).toMatchObject({ score: 90, window: { runs: 1, worstSeverity: 1 } });

    const localRecords = await readQualityRecords('portos-default', 30, now, { query });
    expect(query.mock.calls[1][0]).toMatch(/SELECT category, agent_id, assessed_at, report, slice/);
    expect(localRecords.map(r => r.slice)).toEqual(['server/services/auth', 'Server/Services/Auth']);

    const peer = { id: 'peer-a', instanceId: 'instance-a', enabled: true, address: '192.0.2.1', port: 5555 };
    const getOriginInfo = async () => ({ host: 'github.com', fullName: 'owner/app' });
    const peerPayload = await exportPortosQuality(peer.instanceId, 30, { now, query, getOriginInfo, getPeers: async () => [peer] });
    expect(JSON.stringify(peerPayload)).not.toMatch(/slice|server\/services\/auth/i);
    const snapshot = await buildQualitySnapshot({ id: 'portos-default', repoPath: '/repo' }, null, { now, query, getOriginInfo });
    expect(JSON.stringify(snapshot)).not.toMatch(/slice|server\/services\/auth/i);
    const compactV3 = serializeQualitySnapshot(snapshot.repository,
      snapshot.measurements.map(m => ({ ...m.report, assessedAt: m.assessedAt, measurementId: m.measurementId })));
    expect(compactV3).toContain('"schemaVersion": 3');
    expect(compactV3).not.toMatch(/slice|server\/services\/auth/i);
  });

  it('calibrates audit instructions for whole-slice scoring and below-target re-verification', () => {
    const instructions = auditQualityInstructions('code-quality');
    expect(instructions).toContain(`Before rotating to a new offender, prefer to re-verify a slice in audit-slice-history that scored below ${QUALITY_HEALTHY_THRESHOLD} once its filed issues are closed`);
    expect(instructions).toContain('A finding that led you to choose the slice is only one part of that evidence.');
    expect(instructions).toContain('For a clean slice with worstSeverity 0, score 90–95.');
    expect(instructions).toContain('75–84: Mostly healthy, with localized moderate defects in secondary paths');
    expect(instructions).toContain('40–59: Systemic or recurring defects across core workflows');
    expect(instructions).toContain('0–39: Severe core workflow breakage, data loss, or verified reachable exploits');
    expect(instructions).toContain('Score the whole reviewed slice proportionally');
    expect(instructions).toContain('The pragmatic target band is 85–95. Avoid speculative hardening');
  });

  it('retains both same-day profile scores across snapshot serialization and counts their domain once', () => {
    const timestamp = '2026-09-10T10:00:00Z';
    const rows = ['better-complexity', 'simplify'].map((category, index) =>
      ({ category, assessedAt: timestamp, report: report({ category, score: index ? 80 : 20 }) }));
    const saved = classifyQualitySnapshot(serializeQualitySnapshot('a'.repeat(64),
      rows.map(row => ({ ...row.report, assessedAt: timestamp }))));
    expect(saved.records.map(row => [row.category, row.score]).sort()).toEqual([['better-complexity', 20], ['simplify', 80]]);
    const history = buildAppQualityHistory(rows, 1, Date.parse(timestamp));
    expect(history.points[0]).toMatchObject({ score: 50, ratedCategories: 1, categories: {
      'better-complexity': { score: 20 }, simplify: { score: 80 }, 'code-simplification': { score: 50 },
    } });
  });

  it('names every legacy series a consolidated domain row folds in, measured or not', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const rows = [
      ['ux', 70, '2026-09-10T09:00:00Z'], ['ux', 50, '2026-09-09T09:00:00Z'],
      ['design', 90, '2026-07-01T09:00:00Z'], ['design-usability', 80, '2026-09-10T10:00:00Z'],
    ].map(([category, score, at]) => ({ category, assessedAt: at, report: report({ category, score }) }));
    const row = summarizeAppQuality(rows, now).categories.find(c => c.id === 'design-usability');
    expect(row.members.map(({ id, score, stale }) => [id, score, stale])).toEqual([
      ['design-usability', 80, false], ['design', 90, true], ['ux', 70, false], ['mobile-responsive', null, false],
    ]);
    expect(row.members.find(m => m.id === 'ux').label).toBe('UX');
    expect(summarizeAppQuality(rows, now).categories.find(c => c.id === 'security')).not.toHaveProperty('members');
  });

  it('selects the same numeric winner for local and published records at an exact timestamp tie', () => {
    const at = '2026-09-10T10:00:00.000Z';
    const a = { category: 'security', assessedAt: at, agentId: 'a', report: report({ category: 'security', score: 40 }) };
    const b = { category: 'security', assessedAt: at, agentId: 'z', report: report({ category: 'security', score: 90 }) };
    const compact = serializeQualitySnapshot('a'.repeat(64), [a, b].map(({ assessedAt, report: value }) => ({ ...value, assessedAt })));
    const saved = classifyQualitySnapshot(compact).records[0];
    const release = { category: saved.category, assessedAt: saved.assessedAt, sourcePeerName: 'Release snapshot',
      report: { version: 1, ...saved, summary: 'Published' } };
    delete release.report.assessedAt;
    delete release.report.measurementId;
    const select = rows => summarizeAppQuality(dailyQualityRecords(rows), Date.parse(at)).categories.find(c => c.id === 'security').score;
    expect(select([a, b, release])).toBe(saved.score);
    expect(select([release, b, a])).toBe(saved.score);
    expect(dailyQualityRecords([a, b, release]).every(r => !r.sourcePeerName)).toBe(true);
  });

  it('keeps a local applicability ruling when the same run is present in the release snapshot', () => {
    const local = { category: 'security', assessedAt: '2026-09-10T10:00:00Z', agentId: 'local', report: report({
      category: 'security', score: null, coverage: 'not-applicable', scannedFiles: 0, totalFiles: 0,
    }) };
    const release = { ...local, agentId: null, sourcePeerName: 'Release snapshot' };
    const daily = dailyQualityRecords([local, release]);
    expect(daily[0].agentId).toBe('local');
    expect(summarizeAppQuality(daily, Date.parse('2026-09-10T12:00:00Z')).categories.find(c => c.id === 'security'))
      .toMatchObject({ applicable: false, coverage: 'not-applicable' });
  });

  it('shows retired numeric history separately from the active overall score', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const active = { category: 'security', assessedAt: '2026-09-10T10:00:00Z', report: report({ category: 'security', score: 80 }) };
    const retired = { category: 'retired-audit', assessedAt: '2026-09-10T09:00:00Z', report: report({ category: 'retired-audit', score: 20 }) };
    const history = buildAppQualityHistory([active, retired], 1, now);
    expect(history.additionalCategories).toEqual([{ id: 'retired-audit', label: 'Other / previous: retired-audit' }]);
    expect(history.points[0]).toMatchObject({ score: 80, ratedCategories: 1, categories: { 'retired-audit': { score: 20 } } });
  });

  it.each([
    [report, 12710, 12721, 'broad'],
    [sliceReport, 95, 100, 'broad'],
    [report, 949, 1000, 'partial'],
  ])('counts qualifying near-complete scans without altering stored evidence', async (makeReport, scannedFiles, totalFiles, coverage) => {
    const evidence = makeReport({ scannedFiles, totalFiles });
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const run = { task, taskType: 'better-complexity', agentId: 'agent-coverage',
      workspacePath: '/repo', success: true, assessedAt };
    expect(await recordAuditQuality(run, {
      readFile: async () => sentinel(evidence), query, ensureSchema: vi.fn(),
    })).toBe(true);
    const stored = JSON.parse(query.mock.calls[0][1][4]);
    expect(stored).toEqual({ ...evidence, coverage });
    const summary = summarizeAppQuality([{ category: run.taskType, report: stored, assessedAt }], Date.parse(assessedAt));
    expect(summary).toMatchObject(coverage === 'broad' ? { score: 35, ratedCategories: 1 } : { score: null, ratedCategories: 0 });
    expect(summary.categories.find(category => category.id === 'code-simplification'))
      .toMatchObject({ coverage, scannedFiles, totalFiles });
    expect(numericQualityReport(stored)).toMatchObject({
      version: 1, coverage, scannedFiles: coverage === 'broad' ? totalFiles : scannedFiles, totalFiles,
    });
    expect(stored.scannedFiles).toBe(scannedFiles);
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
    expect(quality.categories.find(c => c.id === 'design-usability')).toMatchObject({ score: 100, stale: true });
    expect(summarizeAppQuality().score).toBeNull();
  });

  // The regression: a backend API was reported as "2 of 30 categories" because
  // seven UI audits it cannot have findings for sat in the denominator.
  it('drops categories that cannot apply from the denominator, unless rated evidence says they do', () => {
    const now = Date.now();
    const records = [
      ['code-quality', 80, 'broad', 'high'],
      ['privacy', null, 'not-applicable', 'low'],
      ['mobile-responsive', 60, 'broad', 'high'],
    ].map(([category, score, coverage, confidence]) => ({ category, report: report({ category, score, coverage, confidence }), assessedAt: new Date(now).toISOString() }));
    const quality = summarizeAppQuality(records, now, { inapplicable: { accessibility: 'no user interface found', 'design-usability': 'no user interface found' } });
    const byId = Object.fromEntries(quality.categories.map(c => [c.id, c]));
    expect(byId.accessibility).toMatchObject({ applicable: false, inapplicableReason: 'no user interface found' });
    expect(byId.privacy).toMatchObject({ applicable: false, inapplicableReason: expect.stringMatching(/not applicable/) });
    // Detected as UI-less, but a fresh broad assessment exists: it counts.
    expect(byId['design-usability']).toMatchObject({ applicable: true, inapplicableReason: null });
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

    expect(summarizeAppQuality([legacy], now).categories.find(category => category.id === 'ui-runtime-bugs'))
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
    const peerRow = { category: 'design-usability', sourcePeerId: 'peer-a', sourcePeerName: 'Peer A', assessedAt: new Date(now).toISOString(),
      report: report({ category: 'design-usability', score: null, coverage: 'not-applicable', confidence: 'low' }) };
    const localRow = { ...peerRow, sourcePeerId: undefined, sourcePeerName: undefined };
    expect(summarizeAppQuality([peerRow], now).categories.find(c => c.id === 'design-usability').applicable).toBe(true);
    expect(summarizeAppQuality([localRow], now).categories.find(c => c.id === 'design-usability').applicable).toBe(false);
  });

  // The detail read feeds the repository scan into the summary; a failing scan
  // must cost only the applicability, never the whole quality read.
  it('asks each federated peer once for the whole app list', async () => {
    const peerFetch = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, repositories: {} }), { status: 200 }));
    await enrichAppsWithQuality([
      { id: 'one', repoPath: '/repo/one' },
      { id: 'two', repoPath: '/repo/two' },
    ], {
      now: Date.parse('2026-09-10T12:00:00Z'),
      query: async () => ({ rows: [] }),
      readFile: async () => null,
      getPeers: async () => [{ id: 'peer-a', instanceId: 'instance-a', enabled: true, address: '192.0.2.1', port: 5555 }],
      getOriginInfo: async (path) => ({ host: 'github.com', fullName: path }),
      peerFetch,
    });
    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(peerFetch.mock.calls[0][0]).toContain('repositories=');
    expect(peerFetch.mock.calls[0][0]).not.toContain('&repository=');
  });

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
  expect(points.find(p => p.date === '2026-09-09')).toMatchObject({ score: 51, ratedCategories: 1 });
  expect(points.at(-1)).toMatchObject({ score: 71, ratedCategories: 2 });
  expect(points.at(-1).categories['better-complexity']).toMatchObject({ score: 51, coverage: 'broad', confidence: 'high' });
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
  expect(summary.categories.find(category => category.id === 'reliability-error-handling')).toMatchObject({ score: null, coverage: 'partial' });
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

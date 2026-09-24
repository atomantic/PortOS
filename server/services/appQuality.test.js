import { describe, it, expect, vi } from 'vitest';
import { recordAuditQuality, enrichAppsWithQuality } from './appQuality.js';
import { AUDIT_DEFINITIONS } from '../lib/auditCatalog.js';
import { AUDIT_DISCOVERY, auditQualityInstructions, parseAuditQualityReport, summarizeAppQuality, AUDIT_FRESHNESS_MS, buildAppQualityHistory } from '../lib/auditQuality.js';

const report = (overrides = {}) => ({ version: 1, category: 'better-complexity', score: 35, worstSeverity: 8,
  coverage: 'broad', confidence: 'high', summary: 'The checkout has a major branching hotspot in the job dispatcher.', scannedFiles: 100, totalFiles: 100, ...overrides });
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
    expect(query.mock.calls[0][1]).toEqual(['portos-default', 'better-complexity', 'agent-1', assessedAt, JSON.stringify(report())]);

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
      JSON.stringify({ ...legacyReport, category: 'ui-lifecycle' }),
    ]);
  });

  it('rejects malformed, cross-category, duplicate and dishonest coverage reports and failed runs without writing', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const query = vi.fn();
    const run = { task, taskType: 'better-complexity', agentId: 'agent-1', workspacePath: '/repo', success: true, assessedAt };
    for (const contents of ['', sentinel(report({ score: 101 })), sentinel(report({ score: '35' })), sentinel(report({ category: 'security' })), sentinel(report({ scannedFiles: 3 })), sentinel(report({ coverage: 'unavailable' })), sentinel(report()) + sentinel(report())]) {
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

it('retains historical scores without hindsight, expires old evidence and exposes changed coverage', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const rows = [
    { category: 'better-complexity', assessedAt: '2026-08-01T12:00:00Z', report: report({ score: 20 }) },
    { category: 'better-complexity', assessedAt: '2026-09-09T12:00:00Z', report: report({ score: 70 }) },
    { category: 'security', assessedAt: '2026-09-10T10:00:00Z', report: report({ category: 'security', score: 90 }) },
  ];
  const { points } = buildAppQualityHistory(rows, 90, now);
  expect(points.find(p => p.date === '2026-07-31').score).toBeNull();
  expect(points.find(p => p.date === '2026-08-01')).toMatchObject({ score: 20, ratedCategories: 1 });
  expect(points.find(p => p.date === '2026-09-01').score).toBeNull();
  expect(points.find(p => p.date === '2026-09-09')).toMatchObject({ score: 70, ratedCategories: 1 });
  expect(points.at(-1)).toMatchObject({ score: 80, ratedCategories: 2 });
});

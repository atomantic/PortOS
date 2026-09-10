import { describe, it, expect, vi } from 'vitest';
import { recordAuditQuality, enrichAppsWithQuality } from './appQuality.js';
import { AUDIT_DEFINITIONS } from '../lib/auditCatalog.js';
import { AUDIT_DISCOVERY, auditQualityInstructions, parseAuditQualityReport, summarizeAppQuality, AUDIT_FRESHNESS_MS } from '../lib/auditQuality.js';

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
  });

  it('accepts the structured sentinel envelope and uses server-owned app, category and run provenance', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ensureSchema = vi.fn();
    await expect(recordAuditQuality({ task, taskType: 'better-complexity', agentId: 'agent-1', workspacePath: '/repo', success: true, assessedAt }, {
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ summary: sentinel(report()), payload: null })), query, ensureSchema,
    })).resolves.toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['portos-default', 'better-complexity', 'agent-1', assessedAt, JSON.stringify(report())]);

  });

  it('rejects malformed, cross-category, duplicate and dishonest coverage reports and failed runs without writing', async () => {
    const query = vi.fn();
    const run = { task, taskType: 'better-complexity', agentId: 'agent-1', workspacePath: '/repo', success: true, assessedAt };
    for (const contents of ['', sentinel(report({ score: 101 })), sentinel(report({ score: '35' })), sentinel(report({ category: 'security' })), sentinel(report({ scannedFiles: 3 })), sentinel(report({ coverage: 'unavailable' })), sentinel(report()) + sentinel(report())]) {
      expect(await recordAuditQuality(run, { readFile: async () => contents, query })).toBe(false);
    }
    expect(await recordAuditQuality({ ...run, success: false }, { readFile: async () => sentinel(report()), query })).toBe(false);
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
    expect(quality).toMatchObject({ score: 40, ratedCategories: 2, totalCategories: 25 });
    expect(quality.categories.find(c => c.id === 'ux')).toMatchObject({ score: 100, stale: true });
    expect(summarizeAppQuality().score).toBeNull();
  });

  it('makes database unavailability explicit without failing app management', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [app] = await enrichAppsWithQuality([{ id: 'app' }], { query: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(app.quality).toMatchObject({ unavailable: true, score: null });
    log.mockRestore();
  });
});

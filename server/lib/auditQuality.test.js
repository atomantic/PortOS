// The feature priority scope in the audit prompt (#18524): which lanes it narrows, which it must not, and that an
// install with nothing to say gets the prompt it always got.
import { describe, it, expect } from 'vitest';
import { auditQualityInstructions } from './auditQuality.js';
import { ACTIVE_AUDIT_DOMAIN_IDS, CONSOLIDATED_AUDIT_DOMAINS } from './auditDomains.js';
import { AUDIT_EXECUTION_TASK_TYPES } from './auditCatalog.js';

const HEADING = '## Feature priority scope';
const APP = { id: 'portos-default', name: 'PortOS', deploymentModel: 'One person, private network.' };

const dormant = { label: 'Dormant Area', globs: ['server/services/dormant*', 'client/src/pages/Dormant!(Keep*)'] };
const lowUse = { label: 'Low Use Area', globs: ['server/{routes,services}/lowuse*'] };
const daily = { label: 'Daily Area', globs: ['server/services/daily/**'] };
const SCOPE = { exempt: false, p0: [daily], p2: [lowUse], p3: [dormant] };

const EXEMPT_TYPES = ['security', 'privacy', 'data-integrity-safety', ...CONSOLIDATED_AUDIT_DOMAINS['data-integrity-safety'].members];
const NON_EXEMPT_TYPES = AUDIT_EXECUTION_TASK_TYPES.filter((id) => !EXEMPT_TYPES.includes(id));

const section = (prompt) => {
  const start = prompt.indexOf(HEADING);
  return start === -1 ? '' : prompt.slice(start, prompt.indexOf('## Reachability check'));
};

describe('feature priority scope in audit instructions', () => {
  it.each(ACTIVE_AUDIT_DOMAIN_IDS)('%s: a scope with nothing to say leaves the prompt byte-identical', (id) => {
    const unscoped = auditQualityInstructions(id, APP);
    expect(unscoped).not.toContain(HEADING);
    const silent = [
      undefined,
      null,
      {},
      { exempt: false, p0: [], p2: [], p3: [] },
      // An area with no globs names no path, so it has nothing to scope.
      { exempt: false, p0: [{ label: 'Empty', globs: [] }], p2: [{ label: 'Malformed' }], p3: [null] },
    ];
    for (const priorityScope of silent) {
      expect(auditQualityInstructions(id, APP, { priorityScope })).toBe(unscoped);
    }
    expect(auditQualityInstructions(id, APP, {})).toBe(unscoped);
  });

  it('covers every exempt and non-exempt audit type the catalog can dispatch', () => {
    for (const id of EXEMPT_TYPES) expect(AUDIT_EXECUTION_TASK_TYPES).toContain(id);
    expect(NON_EXEMPT_TYPES.length).toBeGreaterThan(20);
  });

  it.each(NON_EXEMPT_TYPES)('%s: takes P3 out of the inventory and carries the P2 and P0 rules', (id) => {
    const prompt = auditQualityInstructions(id, APP, { priorityScope: SCOPE });
    const text = section(prompt);
    // The scope sits after the report contract and before the reachability section, and replaces nothing.
    expect(prompt.replace(text, '')).toBe(auditQualityInstructions(id, APP));
    expect(text).toContain('remove every path matching these globs from the step 1 inventory');
    expect(text).toContain('totalFiles and scannedFiles count only the inventory that remains');
    expect(text).toContain('never choose one as the slice or name it in AUDIT_SLICE');
    expect(text).toContain('A verified defect in P3 code met while tracing something else is still filed.');
    expect(text).toContain('  - Dormant Area: `server/services/dormant*`, `client/src/pages/Dormant!(Keep*)`');
    expect(text).toContain('- P2: file or fix verified functional or reliability defects only. No polish, micro-optimization, refactor, copy or speculative test work.\n  - Low Use Area: `server/{routes,services}/lowuse*`');
    expect(text).toContain('- P0: the first tie-break after severity and user impact, ahead of churn and fan-in, and preferred when rotating slices.\n  - Daily Area: `server/services/daily/**`');
    expect(text).toContain('A path matching none of the globs above is audited as P1');
    expect(text).toContain('do not restate tiers, these lists or this section in issues, pull requests or commit messages');
    expect(text).not.toContain('stay fully in scope');
  });

  it.each(EXEMPT_TYPES)('%s: keeps P3 fully in scope and excludes nothing', (id) => {
    const text = section(auditQualityInstructions(id, APP, { priorityScope: SCOPE }));
    expect(text).toContain('P3 areas stay fully in scope for this lane and nothing is removed from the inventory');
    expect(text).toContain('still shares the server, database, credentials and host privileges');
    expect(text).toContain('  - Dormant Area: `server/services/dormant*`, `client/src/pages/Dormant!(Keep*)`');
    expect(text).toContain('do not restate tiers, these lists or this section in issues, pull requests or commit messages');
    expect(text).not.toMatch(/remove every path|out of scope|--exclude|totalFiles/);
    // The narrowing tiers mean nothing to a lane that audits the whole repository.
    expect(text).not.toMatch(/Low Use Area|Daily Area|- P2|- P0|audited as P1/);
  });

  it.each(EXEMPT_TYPES)('%s: says nothing when no area is dormant, whatever the other tiers hold', (id) => {
    const priorityScope = { exempt: true, p0: [daily], p2: [lowUse], p3: [] };
    expect(auditQualityInstructions(id, APP, { priorityScope })).toBe(auditQualityInstructions(id, APP));
  });

  it('decides exemption from the task type, so a wrong flag on the scope cannot narrow a security audit', () => {
    const text = section(auditQualityInstructions('security', APP, { priorityScope: { ...SCOPE, exempt: false } }));
    expect(text).toContain('stay fully in scope');
    const narrowed = section(auditQualityInstructions('performance-efficiency', APP, { priorityScope: { ...SCOPE, exempt: true } }));
    expect(narrowed).toContain('remove every path matching these globs');
  });

  it('lists only the tiers that have an area', () => {
    const onlyP2 = section(auditQualityInstructions('accessibility', APP, { priorityScope: { p2: [lowUse] } }));
    expect(onlyP2).toContain('- P2:');
    expect(onlyP2).not.toMatch(/- P3|- P0|--exclude/);
    expect(onlyP2).toContain('audited as P1');
  });

  it('hands the complexity lanes a ready command that excludes every P3 glob, and no other lane', () => {
    const command = "npm run quality:complexity -- --exclude 'server/services/dormant*' --exclude 'client/src/pages/Dormant!(Keep*)'";
    for (const id of ['better-complexity', 'code-simplification']) {
      expect(section(auditQualityInstructions(id, APP, { priorityScope: SCOPE }))).toContain(command);
    }
    for (const id of ['simplify', 'performance-efficiency', 'security']) {
      expect(section(auditQualityInstructions(id, APP, { priorityScope: SCOPE }))).not.toContain('--exclude');
    }
    // Nothing dormant: the shipped command already covers the right files.
    expect(auditQualityInstructions('better-complexity', APP, { priorityScope: { p2: [lowUse] } })).not.toContain('--exclude');
  });

  it('reads labels and globs only, so no usage count, date or tier source can reach the prompt', () => {
    const leaky = { ...dormant, activeDays30: 4242, lastActiveDay: '2020-02-29', source: 'feature-off', tier: 'P3', areaId: 'dormant-area-id', visits: 7373 };
    const priorityScope = { exempt: false, evidenceDays: 5151, p0: [{ ...daily, source: 'learned', activeDays30: 6262 }], p2: [{ ...lowUse, source: 'pinned' }], p3: [leaky] };
    for (const id of ['performance-efficiency', 'security']) {
      const text = section(auditQualityInstructions(id, APP, { priorityScope }));
      expect(text).toContain('Dormant Area');
      expect(text).not.toMatch(/4242|2020-02-29|feature-off|dormant-area-id|7373|5151|6262|learned|pinned/);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

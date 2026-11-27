import { describe, it, expect } from 'vitest';
import { AUDIT_TASK_TYPE_BY_PRESET_ID } from './quotaBurnLegacyConversion.js';
import { QUOTA_BURN_PROMPT_PRESETS } from './quotaBurnPresets.js';
import { requireSlashdoSubmoduleInCi } from './testHelper.js';
import { LIGHT_FINDINGS_BATCH_EXCEPTION } from './dispatchLabels.js';
import {
  applyDepfreeMode,
  AUDIT_DEFINITIONS,
  AUDIT_TASK_TYPES,
  AUDIT_TASK_TYPE_LIST,
  AUDIT_REPO_CAPABILITIES,
  AUDIT_CAPABILITY_MISSING_REASON,
  auditCapabilityRequirement,
  getAuditFilingPreset,
  getAuditScheduleMetadata,
  FILE_ISSUES_MODE_CONTRACT,
  DO_WORK_MODE_CONTRACT,
  OUT_OF_SCOPE_FINDINGS_RULE,
  isAuditTaskType,
  defaultFileIssuesFor,
  auditDoWorkRequiresWorktree,
  isFileIssuesMode,
  isExplicitFileIssuesRequest,
  FILE_ISSUES_DELIVERY_SETTINGS,
  metricLabelFromSlugPrefix,
  modeContractFor,
  applyAuditModeWrapper,
  DO_BETTER_SCOPE_COVERAGE,
  DO_BETTER_LENS_COVERAGE,
  AUDIT_RUN_GUIDANCE,
  AUDIT_SUGGESTED_AFTER,
  AUDIT_REDACTION_RULE,
} from './auditCatalog.js';

describe('AUDIT_DEFINITIONS', () => {
  it('registers exactly 16 domains and resolves each retired ID to one of them', async () => {
    const { AUDIT_DOMAIN_ALIASES, auditDomainFor } = await import('./auditDomains.js');
    const { DEFAULT_TASK_INTERVALS, SELF_IMPROVEMENT_TASK_TYPES } = await import('../services/taskScheduleRegistry.js');
    expect(Object.keys(AUDIT_DEFINITIONS)).toEqual([...AUDIT_TASK_TYPE_LIST]);
    expect(AUDIT_TASK_TYPE_LIST).toHaveLength(16);
    expect(Object.keys(AUDIT_DOMAIN_ALIASES)).toHaveLength(31);
    for (const id of Object.keys(AUDIT_DOMAIN_ALIASES)) {
      expect(AUDIT_TASK_TYPES.has(auditDomainFor(id)), id).toBe(true);
      expect(AUDIT_DEFINITIONS, id).not.toHaveProperty(id);
      expect(DEFAULT_TASK_INTERVALS, id).not.toHaveProperty(id);
      expect(SELF_IMPROVEMENT_TASK_TYPES).not.toContain(id);
    }
    for (const id of AUDIT_TASK_TYPE_LIST) expect(DEFAULT_TASK_INTERVALS, id).toHaveProperty(id);
    const metrics = Object.values(AUDIT_DEFINITIONS).map(def => def.filing.metricLabel);
    expect(new Set(metrics).size).toBe(metrics.length);
  });

  it('has a filing preset (slug + label) for every audit type', () => {
    for (const [taskType, def] of Object.entries(AUDIT_DEFINITIONS)) {
      expect(def.filing, taskType).toBeTruthy();
      expect(def.filing.slugPrefix, taskType).toMatch(/-$/);
      expect(def.filing.issueLabel, taskType).toBeTruthy();
      expect(def.filing.metricLabel, taskType).toBe(metricLabelFromSlugPrefix(def.filing.slugPrefix));
      expect(def.filing.extraLabels, taskType).toEqual(
        def.filing.metricLabel === def.filing.issueLabel ? [] : [def.filing.metricLabel]
      );
      expect(def.filing.planCommitMessage, taskType).toContain('propose');
    }
  });

  it('maps each historical quota-burn preset onto an active domain', () => {
    expect(Object.keys(AUDIT_TASK_TYPE_BY_PRESET_ID).sort()).toEqual(QUOTA_BURN_PROMPT_PRESETS.map(({ id }) => id).sort());
    for (const type of Object.values(AUDIT_TASK_TYPE_BY_PRESET_ID)) expect(AUDIT_TASK_TYPES.has(type)).toBe(true);
  });

  it('defaults new audit types to file-issues and existing do-work types to implement', () => {
    expect(defaultFileIssuesFor('ux')).toBe(true);
    expect(defaultFileIssuesFor('data-safety')).toBe(true);
    expect(defaultFileIssuesFor('simplify')).toBe(true);
    expect(defaultFileIssuesFor('module-hygiene')).toBe(true);
    expect(defaultFileIssuesFor('test-coverage')).toBe(true); // #12087
    expect(defaultFileIssuesFor('security')).toBe(false);
    expect(defaultFileIssuesFor('accessibility')).toBe(false);
    expect(defaultFileIssuesFor('unknown')).toBe(false);
  });

  it('declares isolation as a catalog capability only for audits that require it', () => {
    expect(auditDoWorkRequiresWorktree('module-hygiene')).toBe(true);
    expect(auditDoWorkRequiresWorktree('ui-runtime-bugs')).toBe(false);
    expect(auditDoWorkRequiresWorktree('unknown')).toBe(false);
  });

  it('names a known repository shape for every audit that requires one', () => {
    for (const taskType of AUDIT_TASK_TYPE_LIST) {
      const requirement = auditCapabilityRequirement(taskType);
      if (requirement === null) continue;
      expect(AUDIT_REPO_CAPABILITIES).toContain(requirement);
      expect(AUDIT_CAPABILITY_MISSING_REASON[requirement]).toBeTruthy();
    }
    expect(auditCapabilityRequirement('accessibility')).toBe('ui');
    expect(auditCapabilityRequirement('unknown')).toBeNull();
    // Deliberately ungated: the repository with no tests is the one this audit
    // has the most to say about. Its sibling assesses tests that exist.
    expect(auditCapabilityRequirement('test-coverage')).toBeNull();
    expect(auditCapabilityRequirement('test-quality-coverage')).toBeNull();
  });

  it('enumerates the audits in catalog order without a second vocabulary', () => {
    expect(AUDIT_TASK_TYPE_LIST).toEqual([...AUDIT_TASK_TYPES]);
    expect(AUDIT_TASK_TYPE_LIST.every(isAuditTaskType)).toBe(true);
  });

  it('routes historic lifecycle IDs to the UI runtime domain', () => {
    expect(isAuditTaskType('react-lifecycle')).toBe(true);
    expect(AUDIT_TASK_TYPES.has('react-lifecycle')).toBe(false);
    expect(getAuditFilingPreset('react-lifecycle')).toBe(getAuditFilingPreset('ui-runtime-bugs'));
    expect(getAuditScheduleMetadata('react-lifecycle').displayName).toBe('better-ui-runtime-bugs');
  });
});

describe('isFileIssuesMode', () => {
  it('is false for non-audit types', () => {
    expect(isFileIssuesMode('claim-issue', { fileIssues: true })).toBe(false);
    expect(isAuditTaskType('claim-issue')).toBe(false);
  });

  it('honors an explicit boolean (and the TASKS.md string form)', () => {
    expect(isFileIssuesMode('security', { fileIssues: true })).toBe(true);
    expect(isFileIssuesMode('security', { fileIssues: 'true' })).toBe(true);
    expect(isFileIssuesMode('ux', { fileIssues: false })).toBe(false);
    expect(isFileIssuesMode('ux', { fileIssues: 'false' })).toBe(false);
  });

  it('falls back to the catalog default when the key is absent', () => {
    expect(isFileIssuesMode('ux', {})).toBe(true);
    expect(isFileIssuesMode('security', {})).toBe(false);
    expect(isFileIssuesMode('data-safety', null)).toBe(true);
  });

  // The override a migrated issues-only burn step writes: an explicit `true`
  // has to beat a shipped scheduled default of `false`, or migrating an
  // issues-only burn preset onto `security` would silently convert it into
  // code-writing work.
  it('an explicit true beats a shipped false default', () => {
    expect(defaultFileIssuesFor('security')).toBe(false);
    expect(isFileIssuesMode('security', { fileIssues: true })).toBe(true);
    expect(isFileIssuesMode('performance', { fileIssues: 'true' })).toBe(true);
  });
});

describe('isExplicitFileIssuesRequest', () => {
  it('is true only when the dispatch itself asked — absent is not off, and not on', () => {
    expect(isExplicitFileIssuesRequest({ fileIssues: true })).toBe(true);
    expect(isExplicitFileIssuesRequest({ fileIssues: 'true' })).toBe(true);
    expect(isExplicitFileIssuesRequest({ fileIssues: false })).toBe(false);
    expect(isExplicitFileIssuesRequest({})).toBe(false);
    expect(isExplicitFileIssuesRequest(null)).toBe(false);
  });

  // The custom-agent-job lane reads it without a task type, so it must not be
  // gated on the catalog the way isFileIssuesMode is.
  it('is type-agnostic — a custom job has no catalog entry to default from', () => {
    expect(isAuditTaskType('my-custom-job')).toBe(false);
    expect(isFileIssuesMode('my-custom-job', { fileIssues: true })).toBe(false);
    expect(isExplicitFileIssuesRequest({ fileIssues: true })).toBe(true);
  });
});

describe('FILE_ISSUES_DELIVERY_SETTINGS', () => {
  it('is the whole posture, frozen — every flag that could ship code is off', () => {
    expect(FILE_ISSUES_DELIVERY_SETTINGS).toEqual({
      fileIssues: true,
      noCodeOutput: true,
      useWorktree: false,
      openPR: false,
      simplify: false,
    });
    expect(Object.isFrozen(FILE_ISSUES_DELIVERY_SETTINGS)).toBe(true);
  });

  // `worktreeChangesExpected` is derived per dispatch from the RESOLVED tracker:
  // a PLAN.md tracker files by committing checklist items, so its file-issues
  // run legitimately leaves a dirty tree. Baking `false` in here would score
  // every one of those successful runs as a missed deliverable (#3102).
  it('does not pin worktreeChangesExpected — the resolved tracker owns it', () => {
    expect(FILE_ISSUES_DELIVERY_SETTINGS).not.toHaveProperty('worktreeChangesExpected');
  });

  // The legacy burn presets are the OTHER definition of this posture (their
  // `AUDIT_PARAMS`, copied into a job at pick time). They stay compatibility-only
  // inputs to the migration, so they are not deduped into this constant — but
  // they must not disagree with it while both exist.
  it('agrees with the legacy quota-burn audit presets', () => {
    const { fileIssues: _fileIssues, ...runShape } = FILE_ISSUES_DELIVERY_SETTINGS;
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(preset.params, preset.id).toMatchObject(runShape);
    }
  });
});

describe('mode contracts + wrapper', () => {
  it('file-issues contract records findings via {trackerInstructions} and forbids edits', () => {
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('{trackerInstructions}');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('OVERRIDES');
    // A separate item per finding must still let light same-area findings batch (#16569).
    expect(FILE_ISSUES_MODE_CONTRACT).toContain(`as a separate item after the review**, except that ${LIGHT_FINDINGS_BATCH_EXCEPTION}`);
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('same `git status`');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('CI or release failure');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('recurring manual churn');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('first issue is NOT a stopping condition');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('at least three distinct relevant paths');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('every accepted finding in the reviewed slice');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('do not idle to fill time or exceed the run budget');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('any unreviewed inventory');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('Zero or one issue is valid when the reviewed evidence supports it');
    expect(modeContractFor(true)).toBe(`${FILE_ISSUES_MODE_CONTRACT}\n\n${OUT_OF_SCOPE_FINDINGS_RULE}`);
  });

  it('do-work contract requires fixes or tracked dispositions and rejects theoretical findings on ephemeral state', () => {
    expect(DO_WORK_MODE_CONTRACT).toContain('Implement all accepted fixes');
    expect(DO_WORK_MODE_CONTRACT).toContain('{trackerInstructions}');
    expect(DO_WORK_MODE_CONTRACT).toContain('Every actionable finding');
    expect(DO_WORK_MODE_CONTRACT).toContain('Theoretical multi-writer, crash-recovery, or state-preservation findings on ephemeral/regenerable state (git worktrees, caches, agent runs, in-memory locks) are NOT accepted findings');
    expect(DO_WORK_MODE_CONTRACT).toContain('rejected as `not-applicable`');
    expect(DO_WORK_MODE_CONTRACT).not.toContain('Do not create tracker issues');
    expect(modeContractFor(false)).toBe(`${DO_WORK_MODE_CONTRACT}\n\n${OUT_OF_SCOPE_FINDINGS_RULE}`);
  });

  it('prepends the banner when the stored prompt has no placeholder', () => {
    const wrapped = applyAuditModeWrapper('Fix the bug and commit.', FILE_ISSUES_MODE_CONTRACT);
    expect(wrapped.startsWith(FILE_ISSUES_MODE_CONTRACT)).toBe(true);
    expect(wrapped).toContain('Fix the bug and commit.');
  });

  it('leaves a prompt that already has {modeInstructions} untouched', () => {
    const prompt = 'Mission\n\n{modeInstructions}';
    expect(applyAuditModeWrapper(prompt, FILE_ISSUES_MODE_CONTRACT)).toBe(prompt);
  });

  it('is a no-op without a mode banner', () => {
    expect(applyAuditModeWrapper('hello', '')).toBe('hello');
    expect(applyAuditModeWrapper('hello', null)).toBe('hello');
  });
});

describe('getAuditFilingPreset', () => {
  it('returns the preset for an audit type and null otherwise', () => {
    expect(getAuditFilingPreset('data-safety')).toBe(getAuditFilingPreset('data-integrity-safety'));
    expect(getAuditFilingPreset('code-simplification')).toMatchObject({
      issueLabel: 'code-quality', extraLabels: ['code-simplification'],
    });
    expect(getAuditFilingPreset('security').extraLabels).toEqual([]);
    expect(getAuditFilingPreset('claim-issue')).toBeNull();
  });

  it('AUDIT_TASK_TYPES is derived from the definitions table', () => {
    expect(AUDIT_TASK_TYPES).toEqual(new Set(Object.keys(AUDIT_DEFINITIONS)));
  });
});

// PortOS's focused `better-*` tasks map onto current generic slashdo scopes.
// Keep both directions checked so upstream scope changes cannot leave schedule
// labels stale or scopes without owners.
describe('DO_BETTER_SCOPE_COVERAGE', () => {
  it('names only registered audit types, without duplicates', () => {
    for (const [scope, owners] of Object.entries(DO_BETTER_SCOPE_COVERAGE)) {
      expect(Array.isArray(owners), scope).toBe(true);
      expect(owners.length, scope).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(AUDIT_TASK_TYPES.has(owner), `${scope} -> ${owner}`).toBe(true);
      }
      expect(new Set(owners).size, `${scope} lists a duplicate owner`).toBe(owners.length);
    }
  });

  it('keeps the former exported name as the same coverage map', () => {
    expect(DO_BETTER_LENS_COVERAGE).toBe(DO_BETTER_SCOPE_COVERAGE);
  });

  // The seeded schedule row ALWAYS sets taskMetadata.fileIssues, so for a
  // scheduled dispatch the catalog default is never actually consulted — which
  // means the two can disagree and nothing would notice until someone read the
  // catalog and believed it. They encode one product decision; pin them equal.
  it('agrees with the seeded schedule row on every audit default', async () => {
    const { DEFAULT_TASK_INTERVALS } = await import('../services/taskScheduleRegistry.js');
    for (const taskType of AUDIT_TASK_TYPES) {
      const seeded = DEFAULT_TASK_INTERVALS[taskType]?.taskMetadata?.fileIssues;
      if (seeded === undefined) continue; // not seeded with an explicit posture
      expect(seeded, taskType).toBe(defaultFileIssuesFor(taskType));
    }
  });

  it('maps every better-prefixed audit type to a current slashdo scope', () => {
    const covered = new Set(Object.values(DO_BETTER_SCOPE_COVERAGE).flat());
    const orphaned = [...AUDIT_TASK_TYPES]
      .filter((type) => type.startsWith('better-') && !covered.has(type));
    expect(orphaned).toEqual([]);
  });

  // Reads the bundled submodule when it is initialized. This parses the current
  // scope table rather than the retired `For <lens>:` checklist format.
  it('covers every scope the bundled do:better command declares', async () => {
    const { existsSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const { PATHS } = await import('./paths.js');
    // Anchored on PATHS.slashdo rather than a relative URL: a missing file here
    // SKIPS outside CI, so a path that silently goes stale disables the guard
    // instead of failing it — the exact failure this test exists to prevent.
    const auditRef = join(PATHS.slashdo, 'lib', 'better-audit.md');
    if (!existsSync(auditRef)) {
      requireSlashdoSubmoduleInCi(false);
      return;
    }
    const body = readFileSync(auditRef, 'utf8');
    // Scope names are the first code span in each row of the current table.
    const declared = [...body.matchAll(/^\|\s*`([a-z-]+)`/gm)].map(([, scope]) => scope);
    expect(declared.length).toBeGreaterThan(5);
    const missing = declared.filter((scope) => !DO_BETTER_SCOPE_COVERAGE[scope]);
    expect(missing).toEqual([]);
    const stale = Object.keys(DO_BETTER_SCOPE_COVERAGE).filter((scope) => !declared.includes(scope));
    expect(stale).toEqual([]);
  });
});

// The advisory run order and the prose that explains it are two halves of one
// answer to "which audit do I run first?" — the order names task types, the
// prose says why. They can drift silently (nothing dispatches on either), so
// pin the claims they make about each other.
describe('AUDIT_SUGGESTED_AFTER', () => {
  it('names only registered task types, in both directions', async () => {
    const { DEFAULT_TASK_INTERVALS } = await import('../services/taskScheduleRegistry.js');
    for (const [taskType, after] of Object.entries(AUDIT_SUGGESTED_AFTER)) {
      expect(DEFAULT_TASK_INTERVALS[taskType], taskType).toBeDefined();
      for (const dep of after) expect(DEFAULT_TASK_INTERVALS[dep], `${taskType} -> ${dep}`).toBeDefined();
    }
  });

  it('keeps each entry to its immediate predecessors — a restated chain is unreadable', () => {
    for (const [taskType, after] of Object.entries(AUDIT_SUGGESTED_AFTER)) {
      expect(after.length, taskType).toBeLessThanOrEqual(2);
    }
  });

  it('is acyclic, so the shipped ladder reads as one sequence', () => {
    const seen = new Set();
    const walk = (taskType, trail) => {
      expect(trail.includes(taskType), `cycle: ${[...trail, taskType].join(' -> ')}`).toBe(false);
      for (const dep of AUDIT_SUGGESTED_AFTER[taskType] || []) walk(dep, [...trail, taskType]);
      seen.add(taskType);
    };
    for (const taskType of Object.keys(AUDIT_SUGGESTED_AFTER)) walk(taskType, []);
    expect(seen.size).toBeGreaterThan(0);
  });

  // "Head of the order" is a claim about the DATA. A type given a predecessor
  // later must lose that phrasing, or the card contradicts its own chips.
  it('reserves the "head of the order" phrasing for types with no predecessor', () => {
    for (const [taskType, guidance] of Object.entries(AUDIT_RUN_GUIDANCE)) {
      if (!guidance.startsWith('Head of the order')) continue;
      expect(AUDIT_SUGGESTED_AFTER[taskType] || [], taskType).toEqual([]);
    }
  });

  it('explains every type it orders', () => {
    for (const taskType of Object.keys(AUDIT_SUGGESTED_AFTER)) {
      expect(AUDIT_RUN_GUIDANCE[taskType], taskType).toBeTruthy();
    }
  });
});

it('keeps the quota-burn maintenance preset on registered tasks in the advisory order', async () => {
  const { MAINTENANCE_TASK_ORDER } = await import('./maintenanceSequence.js');
  const { DEFAULT_TASK_INTERVALS } = await import('../services/taskScheduleRegistry.js');
  for (const [index, taskType] of MAINTENANCE_TASK_ORDER.entries()) {
    expect(DEFAULT_TASK_INTERVALS[taskType], taskType).toBeDefined();
    for (const predecessor of AUDIT_SUGGESTED_AFTER[taskType] || []) {
      expect(MAINTENANCE_TASK_ORDER.indexOf(predecessor), predecessor).toBeLessThan(index);
    }
  }
});

describe('applyDepfreeMode — the dependency-freedom {depfreeMode} block', () => {
  const TYPE = 'better-dependency-freedom';

  it('renders the default bar when no mode is stored', () => {
    const out = applyDepfreeMode('Bar:\n{depfreeMode}\nEnd', TYPE, {});
    expect(out).toContain('## Removal bar for this run: default');
    expect(out).toContain('Keep large, widely audited libraries');
    expect(out).not.toContain('{depfreeMode}');
    expect(out.startsWith('Bar:')).toBe(true);
  });

  it('renders the extreme bar with its design and parity requirements', () => {
    const out = applyDepfreeMode('{depfreeMode}', TYPE, { depfreeMode: 'extreme' });
    expect(out).toContain('## Removal bar for this run: extreme — the goal is zero dependencies');
    expect(out).toContain('There is no line ceiling.');
    expect(out).toContain('write a replacement design first');
    expect(out).toContain('parity test');
    // The security-sensitive classes stay exempt at every bar.
    expect(out).toContain('TLS, cryptography');
    expect(out).toContain('native bindings');
    expect(out).toContain('strongest available model at maximum');
  });

  it('renders the heavy bar', () => {
    const out = applyDepfreeMode('{depfreeMode}', TYPE, { depfreeMode: 'heavy' });
    expect(out).toContain('## Removal bar for this run: heavy');
    expect(out).toContain('Popularity and download counts do not exempt a library');
  });

  it('prepends the block once to a customized prompt that dropped the token', () => {
    const out = applyDepfreeMode('my custom depfree prompt', TYPE, { depfreeMode: 'extreme' });
    expect(out.startsWith('## Removal bar for this run: extreme')).toBe(true);
    expect(out.match(/## Removal bar for this run/g)).toHaveLength(1);
    expect(out.endsWith('my custom depfree prompt')).toBe(true);
  });

  it('falls back to the default bar for a value the sanitizer would have dropped', () => {
    expect(applyDepfreeMode('{depfreeMode}', TYPE, { depfreeMode: 'zero' })).toContain('Removal bar for this run: default');
  });

  it('leaves every other task type untouched', () => {
    expect(applyDepfreeMode('{depfreeMode}', 'better-complexity', { depfreeMode: 'extreme' })).toBe('{depfreeMode}');
  });
});

// One owner per rule (#12080): redaction and "read AGENTS.md first" live in the
// two mode banners, resolve-every-finding only in the do-work banner, and the
// scan-then-bound contract only in the discovery block — so an assembled prompt
// says each once. A mission body that restates any of them is the regression.
describe('banner-owned rules are not restated by mission bodies (#12080)', () => {
  const BANNER_OWNED = [
    AUDIT_REDACTION_RULE,
    'Redact before you publish',
    /[Nn]ever paste/,
    /Read (?:the|this) (?:project|repository)'s (?:own )?(?:instruction files|`AGENTS\.md`)/,
    'Every accepted finding requires resolution',
    /cheap repository-wide inventory/,
  ];

  it('no audit mission body carries a banner-owned sentence', async () => {
    const { DEFAULT_TASK_PROMPTS } = await import('../services/taskPromptDefaults.js');
    for (const taskType of AUDIT_TASK_TYPE_LIST) {
      const body = DEFAULT_TASK_PROMPTS[taskType];
      expect(body, taskType).toBeTruthy();
      for (const rule of BANNER_OWNED) {
        expect(body, `${taskType} restates ${rule}`).not.toMatch(rule);
      }
    }
  });

  it.each([true, false])('an assembled code-quality prompt states each rule once (fileIssues=%s)', async (fileIssues) => {
    const { DEFAULT_TASK_PROMPTS } = await import('../services/taskPromptDefaults.js');
    const { auditQualityInstructions } = await import('./auditQuality.js');
    const banner = `${modeContractFor(fileIssues)}\n\n${auditQualityInstructions('architecture-maintainability')}`;
    const prompt = applyAuditModeWrapper(DEFAULT_TASK_PROMPTS['architecture-maintainability'], banner)
      .replace('{modeInstructions}', banner);
    const count = (needle) => prompt.split(needle).length - 1;
    expect(count(AUDIT_REDACTION_RULE)).toBe(1);
    expect(count('`AGENTS.md`')).toBe(1);
    expect(count('Every accepted finding requires resolution')).toBe(fileIssues ? 0 : 1);
    expect(count('cheap repository-wide signal scan')).toBe(1);
  });
});

describe('security quality assessment', () => {
  it('applies reachability to customized security audits without excluding real external threats', async () => {
    const { auditQualityInstructions } = await import('./auditQuality.js');
    const security = auditQualityInstructions('security');
    expect(security).toContain('attacker control, a reachable sink and unauthorized impact');
    expect(security).toContain('conditional exposure');
    expect(security).toContain('compromised dependencies');
    expect(security).toContain('browser-origin access');
    expect(security).toContain('only where the actual path invokes it');
    expect(security).toContain('do not reject one solely because it adds validation');
    expect(auditQualityInstructions('architecture-maintainability')).not.toContain('Security assessment:');
  });
});

// Out-of-lane findings used to end as summary notes; both banners carry this
// rule (see the banner equality tests), and each owner must keep its metric
// label, which is what lane health attributes on.
describe('out-of-scope findings', () => {
  it('names every owning lane with its full label set', () => {
    for (const [type, { filing }] of Object.entries(AUDIT_DEFINITIONS)) {
      expect(OUT_OF_SCOPE_FINDINGS_RULE).toContain(`${type}=${[filing.issueLabel, ...filing.extraLabels].join('+')}`);
    }
  });
});

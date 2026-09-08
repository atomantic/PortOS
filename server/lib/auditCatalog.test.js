import { describe, it, expect } from 'vitest';
import { QUOTA_BURN_PROMPT_PRESETS } from './quotaBurnPresets.js';
import { requireSlashdoSubmoduleInCi } from './testHelper.js';
import {
  AUDIT_DEFINITIONS,
  AUDIT_TASK_TYPES,
  FILE_ISSUES_MODE_CONTRACT,
  DO_WORK_MODE_CONTRACT,
  isAuditTaskType,
  defaultFileIssuesFor,
  auditDoWorkRequiresWorktree,
  isFileIssuesMode,
  isExplicitFileIssuesRequest,
  FILE_ISSUES_DELIVERY_SETTINGS,
  getAuditFilingPreset,
  modeContractFor,
  applyAuditModeWrapper,
  DO_BETTER_LENS_COVERAGE,
} from './auditCatalog.js';

describe('AUDIT_DEFINITIONS', () => {
  it('has a filing preset (slug + label) for every audit type', () => {
    for (const [taskType, def] of Object.entries(AUDIT_DEFINITIONS)) {
      expect(def.filing, taskType).toBeTruthy();
      expect(def.filing.slugPrefix, taskType).toMatch(/-$/);
      expect(def.filing.issueLabel, taskType).toBeTruthy();
      expect(def.filing.planCommitMessage, taskType).toContain('propose');
    }
  });

  it('maps every quota-burn audit preset to a scheduled audit type', () => {
    const mapped = new Set(
      Object.values(AUDIT_DEFINITIONS).map((def) => def.quotaBurnId).filter(Boolean)
    );
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(mapped.has(preset.id), `missing scheduled counterpart for ${preset.id}`).toBe(true);
    }
  });

  // The REVERSE of the mapping above. The forward direction stops a new burn
  // preset landing without a scheduled counterpart; this one stops a `quotaBurnId`
  // that names a preset which was renamed or deleted. Once the presets are
  // compatibility-only inputs to the migration, a dangling id here is invisible
  // — nothing dereferences it at runtime — so only a test can catch it.
  it('every non-null quotaBurnId names a preset that exists', () => {
    const presetIds = new Set(QUOTA_BURN_PROMPT_PRESETS.map((preset) => preset.id));
    const referenced = Object.entries(AUDIT_DEFINITIONS)
      .filter(([, def]) => def.quotaBurnId != null);
    // Guards the guard: an accidental `quotaBurnId: null` sweep would make the
    // loop below vacuous while still passing.
    expect(referenced.length).toBeGreaterThan(0);
    for (const [taskType, def] of referenced) {
      expect(presetIds.has(def.quotaBurnId), `${taskType} → unknown preset "${def.quotaBurnId}"`).toBe(true);
    }
  });

  it('never points two audit types at the same burn preset', () => {
    const ids = Object.values(AUDIT_DEFINITIONS).map((def) => def.quotaBurnId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults new audit types to file-issues and existing do-work types to implement', () => {
    expect(defaultFileIssuesFor('ux')).toBe(true);
    expect(defaultFileIssuesFor('data-safety')).toBe(true);
    expect(defaultFileIssuesFor('simplify')).toBe(true);
    expect(defaultFileIssuesFor('module-hygiene')).toBe(true);
    expect(defaultFileIssuesFor('security')).toBe(false);
    expect(defaultFileIssuesFor('accessibility')).toBe(false);
    expect(defaultFileIssuesFor('unknown')).toBe(false);
  });

  it('declares isolation as a catalog capability only for audits that require it', () => {
    expect(auditDoWorkRequiresWorktree('module-hygiene')).toBe(true);
    expect(auditDoWorkRequiresWorktree('simplify')).toBe(false);
    expect(auditDoWorkRequiresWorktree('unknown')).toBe(false);
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
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('same `git status`');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('CI or release failure');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('recurring manual churn');
    expect(modeContractFor(true)).toBe(FILE_ISSUES_MODE_CONTRACT);
  });

  it('do-work contract tells the agent to implement one fix', () => {
    expect(DO_WORK_MODE_CONTRACT).toContain('implement');
    expect(DO_WORK_MODE_CONTRACT).not.toContain('{trackerInstructions}');
    expect(modeContractFor(false)).toBe(DO_WORK_MODE_CONTRACT);
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
    expect(getAuditFilingPreset('data-safety').slugPrefix).toBe('data-safety-');
    expect(getAuditFilingPreset('simplify').issueLabel).toBe('code-quality');
    expect(getAuditFilingPreset('module-hygiene').slugPrefix).toBe('module-hygiene-');
    expect(getAuditFilingPreset('claim-issue')).toBeNull();
  });

  it('AUDIT_TASK_TYPES is derived from the definitions table', () => {
    expect(AUDIT_TASK_TYPES).toEqual(new Set(Object.keys(AUDIT_DEFINITIONS)));
  });
});

// The `better-*` audit types exist to give each slashdo `do:better` audit lens
// a schedulable counterpart. The coverage map is the contract between the two,
// and it only means anything if both halves are checked: that every type it
// names is real, and that every lens upstream declares is actually named.
describe('DO_BETTER_LENS_COVERAGE', () => {
  it('names only registered audit types, without duplicates', () => {
    for (const [lens, owners] of Object.entries(DO_BETTER_LENS_COVERAGE)) {
      expect(Array.isArray(owners), lens).toBe(true);
      expect(owners.length, lens).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(AUDIT_TASK_TYPES.has(owner), `${lens} -> ${owner}`).toBe(true);
      }
      expect(new Set(owners).size, `${lens} lists a duplicate owner`).toBe(owners.length);
    }
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

  it('gives every better-prefixed audit type a lens to be in parity with', () => {
    const covered = new Set(Object.values(DO_BETTER_LENS_COVERAGE).flat());
    const orphaned = [...AUDIT_TASK_TYPES]
      .filter((type) => type.startsWith('better-') && !covered.has(type));
    expect(orphaned).toEqual([]);
  });

  // Reads the bundled submodule when it is initialized. A lens added upstream
  // with no entry here is a category of app quality that silently became
  // unschedulable — exactly the gap these task types were added to close.
  it('covers every lens the bundled do:better command declares', async () => {
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
    // Each lens is introduced as: For `<slug>`:
    const declared = [...body.matchAll(/^For `([a-z-]+)`:/gm)].map(([, slug]) => slug);
    expect(declared.length).toBeGreaterThan(5);
    const missing = declared.filter((lens) => !DO_BETTER_LENS_COVERAGE[lens]);
    expect(missing).toEqual([]);
  });
});

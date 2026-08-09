import { describe, it, expect } from 'vitest';
import {
  createCosTaskSchema,
  updateCosTaskSchema,
  createCosJobSchema,
  updateCosJobSchema,
  describeReviewerCli,
  isCliReviewer,
  reviewerCliBinary,
  DEFAULT_REVIEWER,
  LOCAL_LLM_REVIEWERS,
  REVIEWER_ALIASES,
  REVIEWER_CLI_BINARIES,
  REVIEWER_VALUES,
  EFFORT_SELECTABLE_REVIEWERS,
  LOCAL_LLM_EFFORT_LEVELS,
  reviewerEffortLevels,
  normalizeReviewerEfforts,
  resolveReviewerEfforts,
  reviewerEffortsFromDefaults,
  reviewerEffortArgs,
  buildReviewerEffortNote,
  sanitizeTaskMetadata,
  codeReviewSettingsSchema,
  taskTemplateSettingsSchema,
} from './cosValidation.js';
import { LOCAL_AGENT_REVIEWERS } from './slashdoInvocation.js';
import { EFFORT_LEVELS, CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS, ANTIGRAVITY_EFFORT_LEVELS } from './providerModels.js';

describe('cosValidation effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosTaskSchema.safeParse({ description: 'x', effort }).success).toBe(true);
    }
    expect(createCosTaskSchema.safeParse({ description: 'x', effort: 'bogus' }).success).toBe(false);
  });

  it("create: '' (the form's Default option) parses to absent, not a stored empty pin", () => {
    const parsed = createCosTaskSchema.parse({ description: 'x', effort: '' });
    expect('effort' in parsed && parsed.effort !== undefined).toBe(false);
  });

  it("update: ''/null survive as null so the API can CLEAR a set effort pin", () => {
    // absent-vs-cleared (CLAUDE.md): the route gates on `!== undefined`, and the
    // store's legacy-field normalizer deletes a null pin — so the clear signal
    // must reach the route as null, not be preprocessed away to undefined.
    expect(updateCosTaskSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: 'high' }).effort).toBe('high');
    expect(updateCosTaskSchema.parse({}).effort).toBeUndefined();
    expect(updateCosTaskSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});

describe('cosValidation autonomous-job effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosJobSchema.safeParse({ name: 'j', effort }).success).toBe(true);
    }
    expect(createCosJobSchema.safeParse({ name: 'j', effort: 'bogus' }).success).toBe(false);
  });

  it("mirrors providerId's clearable-null semantics: ''/null → null, absent → undefined", () => {
    // A job effort pin is clearable through a PUT the same way providerId is —
    // '' from the UI picker and an explicit null both persist as null so
    // updateJob (which skips only `undefined`) resets the pin to the provider
    // default; an omitted key stays undefined and preserves the existing value.
    expect(createCosJobSchema.parse({ name: 'j', effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: 'max' }).effort).toBe('max');
    expect(updateCosJobSchema.parse({}).effort).toBeUndefined();
    expect(updateCosJobSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});

describe('cosValidation job taskMetadata.worktreeChangesExpected (#3102)', () => {
  it('accepts the flag and preserves an explicit false (schema parity with the sanitizer)', () => {
    // Zod strips undeclared keys, so an unlisted flag would be silently dropped
    // from a job's taskMetadata — the opt-out has to be declared here too.
    const parsed = createCosJobSchema.parse({
      name: 'j',
      taskMetadata: { useWorktree: true, worktreeChangesExpected: false },
    });
    expect(parsed.taskMetadata).toEqual({ useWorktree: true, worktreeChangesExpected: false });
    expect(createCosJobSchema.safeParse({ name: 'j', taskMetadata: { worktreeChangesExpected: 'nope' } }).success)
      .toBe(false);
  });
});

describe('cosValidation quick-template deliverable posture (#3651)', () => {
  it('taskTemplateSettingsSchema accepts worktreeChangesExpected (the block is .strict())', () => {
    // taskTemplates.js copies the slashdo catalog posture onto each built-in
    // template verbatim; a user saving such a template back would 400 if the
    // strict settings block didn't declare the key.
    const parsed = taskTemplateSettingsSchema.parse({ useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: false });
    expect(parsed).toEqual({ useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: false });
    expect(taskTemplateSettingsSchema.safeParse({ worktreeChangesExpected: true }).success).toBe(true);
    expect(taskTemplateSettingsSchema.safeParse({ worktreeChangesExpected: 'nope' }).success).toBe(false);
    expect(taskTemplateSettingsSchema.safeParse({ bogus: true }).success).toBe(false);
  });

  it('create-task accepts the boolean and the form-encoded string forms', () => {
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: false }).worktreeChangesExpected).toBe(false);
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: true }).worktreeChangesExpected).toBe(true);
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: 'false' }).worktreeChangesExpected).toBe(false);
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: 'true' }).worktreeChangesExpected).toBe(true);
    // Absent must stay absent — cosTaskStore only stamps metadata on a strict
    // boolean, so "no opinion" has to survive as undefined.
    expect(createCosTaskSchema.parse({ description: 'x' }).worktreeChangesExpected).toBeUndefined();
    expect(createCosTaskSchema.safeParse({ description: 'x', worktreeChangesExpected: 'nope' }).success).toBe(false);
  });
});

describe('cosValidation reviewer CLI binaries', () => {
  // The bug this exists to prevent: `antigravity` is the stored, federated
  // reviewer identity, but the shipped executable is `agy` — no `antigravity`
  // command exists. A review-loop follow-up agent handed the bare slug ran
  // `command -v antigravity`, got nothing, concluded "no reviewer is available",
  // self-reviewed, and merged its own PR.
  it('maps the antigravity slug (and its gemini alias) to the agy binary', () => {
    expect(reviewerCliBinary('antigravity')).toBe('agy');
    expect(reviewerCliBinary('gemini')).toBe('agy');
    expect(reviewerCliBinary('ANTIGRAVITY')).toBe('agy');
    expect(describeReviewerCli('antigravity')).toBe('`agy` (the `antigravity` reviewer)');
  });

  it('leaves same-named reviewers alone rather than restating the slug', () => {
    for (const slug of ['claude', 'codex', 'grok']) {
      expect(reviewerCliBinary(slug)).toBe(slug);
      expect(describeReviewerCli(slug)).toBe(`\`${slug}\``);
    }
  });

  it('returns null for reviewers that have no spawnable CLI', () => {
    // copilot is a GitHub API review; lmstudio/ollama go through
    // POST /api/code-review/local. Prompt builders must not tell an agent to
    // run these as commands.
    for (const slug of [DEFAULT_REVIEWER, ...LOCAL_LLM_REVIEWERS]) {
      expect(reviewerCliBinary(slug)).toBeNull();
    }
    expect(reviewerCliBinary(undefined)).toBeNull();
    expect(describeReviewerCli(undefined)).toBe('');
  });

  // Guard the guard: a NEW CLI reviewer added to REVIEWER_VALUES without a
  // binary mapping must be caught here rather than shipping another slug an
  // agent will fruitlessly probe for. Aliases resolve first, so `gemini` is not
  // itself expected in the map. Uses isCliReviewer rather than re-spelling the
  // exclusion, so a change to that rule can actually fail this test.
  it('every CLI reviewer in REVIEWER_VALUES maps to a binary', () => {
    const cliReviewers = REVIEWER_VALUES.filter(isCliReviewer);
    expect(cliReviewers.length).toBeGreaterThan(0);
    for (const slug of cliReviewers) {
      expect(reviewerCliBinary(slug), `reviewerCliBinary('${slug}')`).toBeTruthy();
    }
    for (const alias of Object.keys(REVIEWER_ALIASES)) {
      expect(reviewerCliBinary(alias)).toBe(reviewerCliBinary(REVIEWER_ALIASES[alias]));
    }
  });

  it('agrees with isCliReviewer on which reviewers are spawnable CLIs', () => {
    for (const slug of REVIEWER_VALUES) {
      expect(Boolean(reviewerCliBinary(slug)), slug).toBe(isCliReviewer(slug));
    }
    expect(isCliReviewer(DEFAULT_REVIEWER)).toBe(false);
    expect(LOCAL_LLM_REVIEWERS.some(isCliReviewer)).toBe(false);
  });

  // slashdoInvocation keeps its own copy of the roster to decide which slashdo
  // `lib/*` includes a reviewer needs. Two hand-maintained lists of the same
  // reviewers drift the moment one gains a member — the `grok` addition is the
  // precedent — so pin them to each other rather than making slashdoInvocation
  // import this module (cosValidation already imports IT, and a cycle here would
  // be worse than the duplication).
  it('matches slashdoInvocation LOCAL_AGENT_REVIEWERS', () => {
    expect([...LOCAL_AGENT_REVIEWERS].sort()).toEqual(Object.keys(REVIEWER_CLI_BINARIES).sort());
  });
});

describe('per-reviewer reasoning effort (reviewerEfforts)', () => {
  it('offers each reviewer only the ladder its own CLI accepts', () => {
    expect(reviewerEffortLevels('claude')).toEqual(CLAUDE_EFFORT_LEVELS);
    expect(reviewerEffortLevels('codex')).toEqual(CODEX_EFFORT_LEVELS);
    expect(reviewerEffortLevels('antigravity')).toEqual(ANTIGRAVITY_EFFORT_LEVELS);
    // The `gemini` alias resolves to the same ladder as `antigravity`.
    expect(reviewerEffortLevels('gemini')).toEqual(ANTIGRAVITY_EFFORT_LEVELS);
    expect(reviewerEffortLevels('ollama')).toEqual(LOCAL_LLM_EFFORT_LEVELS);
    expect(reviewerEffortLevels('lmstudio')).toEqual(LOCAL_LLM_EFFORT_LEVELS);
    // No effort control: copilot is a GitHub review, grok's CLI takes no flag,
    // and a `@username` reviewer is a person.
    expect(reviewerEffortLevels('copilot')).toBeNull();
    expect(reviewerEffortLevels('grok')).toBeNull();
    expect(reviewerEffortLevels('@somebody')).toBeNull();
  });

  it('EFFORT_SELECTABLE_REVIEWERS is exactly the reviewers with a non-empty ladder', () => {
    expect([...EFFORT_SELECTABLE_REVIEWERS].sort())
      .toEqual(['antigravity', 'claude', 'codex', 'lmstudio', 'ollama']);
    for (const reviewer of REVIEWER_VALUES) {
      expect(EFFORT_SELECTABLE_REVIEWERS.includes(reviewer))
        .toBe((reviewerEffortLevels(reviewer) || []).length > 0);
    }
  });

  it('normalizes a token-keyed map: aliases, case, and out-of-ladder levels', () => {
    expect(normalizeReviewerEfforts({
      gemini: 'HIGH',        // alias + case-folded
      codex: 'ultra',        // in codex's ladder only
      claude: 'medium',
      ollama: ' low ',       // trimmed
    })).toEqual({ antigravity: 'high', codex: 'ultra', claude: 'medium', ollama: 'low' });
  });

  it('DROPS rather than clamps a level the reviewer rejects — a displayed effort must be the one it runs', () => {
    // `agy` really does reject `--effort max`; clamping it to `high` would review
    // at a different effort than the picker shows.
    expect(normalizeReviewerEfforts({ antigravity: 'max' })).toEqual({});
    // Reviewers with no effort control at all.
    expect(normalizeReviewerEfforts({ copilot: 'high', grok: 'high', '@bot': 'high' })).toEqual({});
    // Non-strings and blanks are absent, never an empty pin.
    expect(normalizeReviewerEfforts({ codex: '', claude: null, ollama: 3 })).toEqual({});
    // Non-object input is undefined so an omitted field isn't persisted as `{}`.
    expect(normalizeReviewerEfforts(undefined)).toBeUndefined();
    expect(normalizeReviewerEfforts(['codex'])).toBeUndefined();
  });

  it('resolves task-over-default, with an explicitly empty task map overriding', () => {
    expect(resolveReviewerEfforts({ codex: 'high' }, { codex: 'low' })).toEqual({ codex: 'high' });
    expect(resolveReviewerEfforts({}, { codex: 'low' })).toEqual({});
    expect(resolveReviewerEfforts(undefined, { codex: 'low' })).toEqual({ codex: 'low' });
  });

  it('folds the settings scalars into the map, re-checking each against its ladder', () => {
    expect(reviewerEffortsFromDefaults({
      codexEffort: 'high',
      claudeEffort: 'xhigh',
      antigravityEffort: 'max',   // not in agy's ladder — dropped, not clamped
      ollamaEffort: 'medium',
      lmstudioEffort: 'ultra',    // OpenAI-shaped backends don't take this tier
      grokEffort: 'high',         // grok has no effort control at all
    })).toEqual({ codex: 'high', claude: 'xhigh', ollama: 'medium' });
    expect(reviewerEffortsFromDefaults(null)).toEqual({});
  });

  it('renders the argv fragment each CLI actually takes', () => {
    expect(reviewerEffortArgs('claude', 'high')).toEqual(['--effort', 'high']);
    expect(reviewerEffortArgs('codex', 'high')).toEqual(['-c', 'model_reasoning_effort=high']);
    // The `antigravity` slug names no executable — `agy` does, and it takes --effort.
    expect(reviewerEffortArgs('antigravity', 'low')).toEqual(['--effort', 'low']);
    expect(reviewerEffortArgs('grok', 'high')).toEqual([]);
    expect(reviewerEffortArgs('copilot', 'high')).toEqual([]);
    expect(reviewerEffortArgs('claude', null)).toEqual([]);
  });

  it('DROPS an out-of-ladder effort instead of clamping it, even from unnormalized input', () => {
    // The underlying `buildEffortArgs` clamps (agy `max` → `--effort high`), which
    // is right for a provider pin carried across providers but wrong for a reviewer
    // effort picked from that reviewer's own list: emitting a clamped flag would run
    // the review at a tier the picker labels `unsupported`. This function is reached
    // with RAW task metadata (`reviewLoopReviewerEfforts`), so it must normalize
    // itself rather than trust the caller.
    expect(reviewerEffortArgs('antigravity', 'max')).toEqual([]);
    expect(reviewerEffortArgs('antigravity', 'ultra')).toEqual([]);
    // Case/whitespace still normalize through rather than being rejected.
    expect(reviewerEffortArgs('codex', ' HIGH ')).toEqual(['-c', 'model_reasoning_effort=high']);
  });

  it('builds the slashdo-invocation note only for CLI reviewers carrying an effort', () => {
    const note = buildReviewerEffortNote(['codex', 'claude', 'copilot'], { codex: 'high', claude: 'low', copilot: 'high' });
    expect(note).toContain('`codex -c model_reasoning_effort=high`');
    expect(note).toContain('`claude --effort low`');
    expect(note).not.toContain('copilot');
    // A reviewer not in the list contributes nothing, and no pins at all = no note.
    expect(buildReviewerEffortNote(['copilot'], { codex: 'high' })).toBe('');
    expect(buildReviewerEffortNote(['codex'], {})).toBe('');
    expect(buildReviewerEffortNote(undefined, { codex: 'high' })).toBe('');
    // slashdo's local-model loop calls the backend itself, so there's no flag to
    // name for lmstudio/ollama in this path.
    expect(buildReviewerEffortNote(['ollama'], { ollama: 'high' })).toBe('');
  });

  it('carries reviewerEfforts through the task schema and the metadata sanitizer', () => {
    const parsed = createCosTaskSchema.parse({
      description: 'x',
      reviewerEfforts: { codex: 'high', antigravity: 'max', copilot: 'low' },
    });
    expect(parsed.reviewerEfforts).toEqual({ codex: 'high' });
    expect(createCosTaskSchema.parse({ description: 'x' }).reviewerEfforts).toBeUndefined();
    // An explicitly empty MAP is KEPT: it's a real "use each reviewer's own
    // default for this task" choice that must override the Code Review Defaults.
    expect(sanitizeTaskMetadata({ reviewerEfforts: {} })).toEqual({ reviewerEfforts: {} });
    expect(sanitizeTaskMetadata({ reviewerEfforts: { claude: 'high', grok: 'high' } }))
      .toEqual({ reviewerEfforts: { claude: 'high' } });
  });

  it('accepts each per-reviewer effort scalar on the code-review settings slice', () => {
    const parsed = codeReviewSettingsSchema.parse({
      claudeEffort: 'max', codexEffort: 'minimal', antigravityEffort: 'high',
      ollamaEffort: 'low', lmstudioEffort: 'high',
    });
    expect(parsed).toEqual({
      claudeEffort: 'max', codexEffort: 'minimal', antigravityEffort: 'high',
      ollamaEffort: 'low', lmstudioEffort: 'high',
    });
    // An unusable stored value clears the field rather than persisting a pin no
    // invocation would carry.
    expect(codeReviewSettingsSchema.parse({ antigravityEffort: 'max' }).antigravityEffort).toBeUndefined();
    expect(codeReviewSettingsSchema.parse({ codexEffort: 'bogus' }).codexEffort).toBeUndefined();
  });
});

// The picker's Effort cell is driven by a CLIENT mirror of these ladders. A level
// offered there but rejected here would show the user a pin that silently never
// persists (and the reverse would hide a tier their CLI accepts), so the mirror is
// pinned rather than trusted to a "keep in sync" comment.
describe('client mirror of the reviewer effort ladders', () => {
  it('matches server reviewerEffortLevels for every reviewer', async () => {
    // The dependency-free leaf, NOT `components/cos/constants.js` (which re-exports
    // these but also imports `lucide-react` — absent from the server workspace, so
    // importing it here fails CI with ERR_MODULE_NOT_FOUND).
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect([...client.EFFORT_SELECTABLE_REVIEWERS].sort()).toEqual([...EFFORT_SELECTABLE_REVIEWERS].sort());
    expect(client.LOCAL_LLM_EFFORT_LEVELS).toEqual(LOCAL_LLM_EFFORT_LEVELS);
    for (const reviewer of REVIEWER_VALUES) {
      expect(client.reviewerEffortLevels(reviewer) ?? null).toEqual(reviewerEffortLevels(reviewer) ?? null);
    }
    // Alias parity too — the picker keys rows off stored slugs.
    expect(client.reviewerEffortLevels('gemini')).toEqual(reviewerEffortLevels('gemini'));
  });
});

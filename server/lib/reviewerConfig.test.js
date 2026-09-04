import { describe, it, expect } from 'vitest';
import {
  describeReviewerCli,
  isCliReviewer,
  reviewerCliBinary,
  DEFAULT_REVIEWER,
  LOCAL_LLM_REVIEWERS,
  REVIEWER_ALIASES,
  REVIEWER_CLI_BINARIES,
  REVIEWER_VALUES,
  EFFORT_SELECTABLE_REVIEWERS,
  MODEL_CAPABLE_CLI_REVIEWERS,
  MODEL_SELECTABLE_REVIEWERS,
  pairReviewerModelsAndEfforts,
  reviewerModelsFromDefaults,
  buildReviewWithArgs,
  LOCAL_LLM_EFFORT_LEVELS,
  reviewerEffortLevels,
  normalizeReviewerEfforts,
  resolveReviewerEfforts,
  reviewerEffortsFromDefaults,
  reviewerEffortArgs,
  reviewerModelArg,
  buildReviewerEffortNote,
  buildReviewerPinNote,
  buildReviewersCsv,
  claimSafeReviewers,
  prioritizeToolFreeReviewers,
  resolveReviewerConfig,
  resolveClaimReviewerConfig,
  reviewerTokenSlug,
  reviewerModelFlag,
  splitSlashdoReviewerTokens,
  PORTOS_ONLY_REVIEWERS,
  DEFAULT_REVIEWERS,
  REVIEW_STOP_MODES,
  REVIEWER_OVERRIDE_KEYS,
  REVIEWER_LIST_OVERRIDE_KEYS,
  hasReviewerOverride,
  DEFAULT_REVIEW_STOP_MODE,
  MAX_REVIEW_USERNAMES,
  MAX_REVIEWER_MAX_ROUNDS,
  normalizeReviewUsernames,
  reviewerForProvider,
  codeReviewDefaultsFromProvider,
} from './reviewerConfig.js';
// The Zod half of the old cosValidation.js — these cases assert that a reviewer
// pin survives the schema that persists it, so they need both modules.
import { createCosTaskSchema, sanitizeTaskMetadata, codeReviewSettingsSchema, reviewerConfigMetadata } from './cosValidation.js';
import { LOCAL_AGENT_REVIEWERS } from './slashdoInvocation.js';
import { CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS, ANTIGRAVITY_EFFORT_LEVELS, CURSOR_EFFORT_LEVELS, GROK_EFFORT_LEVELS } from './providerModels.js';

describe('reviewerConfig reviewer CLI binaries', () => {
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
    expect(reviewerCliBinary('cursor')).toBe('cursor-agent');
    expect(reviewerCliBinary('cursor-agent')).toBe('cursor-agent');
    expect(describeReviewerCli('cursor')).toBe('`cursor-agent` (the `cursor` reviewer)');
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

  // Every coding-agent CLI PortOS can spawn is selectable as a reviewer, so the
  // provider a user is told is their best local agent can also review their code.
  it('covers the OpenCode and Kimi CLIs, naming their own binaries', () => {
    for (const slug of ['opencode', 'kimi']) {
      expect(REVIEWER_VALUES).toContain(slug);
      expect(isCliReviewer(slug)).toBe(true);
      expect(reviewerCliBinary(slug)).toBe(slug);
      expect(MODEL_CAPABLE_CLI_REVIEWERS).toContain(slug);
    }
  });

  // `opencode run -m <provider/model>` — rendering `--model` would send the
  // follow-up agent probing for a flag OpenCode does not document.
  it('spells the model flag the way each CLI does', () => {
    expect(reviewerModelFlag('opencode')).toBe('-m');
    for (const slug of ['codex', 'claude', 'antigravity', 'gemini', 'grok', 'cursor', 'kimi']) {
      expect(reviewerModelFlag(slug)).toBe('--model');
    }
  });

  // MTPLX is an OpenAI-compatible local server, so it reviews through
  // `POST /api/code-review/local` like lmstudio/ollama — never as a spawned CLI.
  it('treats mtplx as a local-LLM backend, not a CLI', () => {
    expect(LOCAL_LLM_REVIEWERS).toContain('mtplx');
    expect(isCliReviewer('mtplx')).toBe(false);
    expect(reviewerCliBinary('mtplx')).toBeNull();
    expect(reviewerEffortLevels('mtplx')).toEqual(LOCAL_LLM_EFFORT_LEVELS);
  });

  // slashdo's `--review-with` vocabulary is copilot/codex/agy/claude/grok/cursor/
  // ollama/@login. Anything else aborts the command, so PortOS's own reviewers
  // must never reach that flag.
  it('classifies every reviewer slashdo cannot parse as PortOS-only', () => {
    expect([...PORTOS_ONLY_REVIEWERS].sort()).toEqual(['kimi', 'lmstudio', 'mtplx', 'opencode']);
    const { flagTokens, portosOnly } = splitSlashdoReviewerTokens([
      'ollama[qwen2.5:7b]~max=1', 'opencode', '@octocat', 'mtplx~effort=high', 'codex',
    ]);
    expect(flagTokens).toEqual(['ollama[qwen2.5:7b]~max=1', '@octocat', 'codex']);
    expect(portosOnly).toEqual(['opencode', 'mtplx']);
  });

  // slashdoInvocation keeps its own copy of the roster to decide which slashdo
  // `lib/*` includes a reviewer needs. Two hand-maintained lists of the same
  // reviewers drift the moment one gains a member — the `grok` addition is the
  // precedent — so pin them to each other rather than making slashdoInvocation
  // import this module (cosValidation.js re-exports this module AND imports
  // slashdoInvocation, so a cycle here would be worse than the duplication).
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
    // cursor has a ladder even though `cursor-agent` takes no `--effort` flag:
    // the level is a variant of its model id, folded in by `reviewerModelArg`.
    expect(reviewerEffortLevels('cursor')).toEqual(CURSOR_EFFORT_LEVELS);
    expect(reviewerEffortLevels('cursor-agent')).toEqual(CURSOR_EFFORT_LEVELS);
    // grok's ladder stops at xhigh — derived from effortLevelsForProvider, so it
    // is exactly what `grok --reasoning-effort` accepts.
    expect(reviewerEffortLevels('grok')).toEqual(GROK_EFFORT_LEVELS);
    // No effort control: copilot is a GitHub review, and a `@username` reviewer
    // is a person.
    expect(reviewerEffortLevels('copilot')).toBeNull();
    expect(reviewerEffortLevels('@somebody')).toBeNull();
  });

  it('EFFORT_SELECTABLE_REVIEWERS is exactly the reviewers with a non-empty ladder', () => {
    expect([...EFFORT_SELECTABLE_REVIEWERS].sort())
      .toEqual(['antigravity', 'claude', 'codex', 'cursor', 'grok', 'lmstudio', 'mtplx', 'ollama']);
    for (const reviewer of REVIEWER_VALUES) {
      expect(EFFORT_SELECTABLE_REVIEWERS.includes(reviewer))
        .toBe((reviewerEffortLevels(reviewer) || []).length > 0);
    }
  });

  it('normalizes a token-keyed map: aliases, case, and out-of-ladder levels', () => {
    expect(normalizeReviewerEfforts({
      gemini: 'HIGH',        // alias + case-folded
      codex: 'xhigh',        // in codex's ladder only
      claude: 'medium',
      ollama: ' low ',       // trimmed
    })).toEqual({ antigravity: 'high', codex: 'xhigh', claude: 'medium', ollama: 'low' });
  });

  it('DROPS rather than clamps a level the reviewer rejects — a displayed effort must be the one it runs', () => {
    // `agy` really does reject `--effort max`; clamping it to `high` would review
    // at a different effort than the picker shows.
    expect(normalizeReviewerEfforts({ antigravity: 'max' })).toEqual({});
    // grok rejects `max` the way agy rejects it — dropped, not clamped.
    expect(normalizeReviewerEfforts({ grok: 'max' })).toEqual({});
    expect(normalizeReviewerEfforts({ grok: 'xhigh' })).toEqual({ grok: 'xhigh' });
    // Reviewers with no effort control at all.
    expect(normalizeReviewerEfforts({ copilot: 'high', '@bot': 'high' })).toEqual({});
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
      grokEffort: 'high',         // in grok's ladder — kept
    })).toEqual({ codex: 'high', claude: 'xhigh', ollama: 'medium', grok: 'high' });
    expect(reviewerEffortsFromDefaults(null)).toEqual({});
  });

  it('renders the argv fragment each CLI actually takes', () => {
    expect(reviewerEffortArgs('claude', 'high')).toEqual(['--effort', 'high']);
    expect(reviewerEffortArgs('codex', 'high')).toEqual(['-c', 'model_reasoning_effort=high']);
    // The `antigravity` slug names no executable — `agy` does, and it takes --effort.
    expect(reviewerEffortArgs('antigravity', 'low')).toEqual(['--effort', 'low']);
    // grok's CLI takes `--reasoning-effort`, aliased `--effort` — the alias is
    // what buildEffortArgs emits, and `max` is outside its ladder so it drops.
    expect(reviewerEffortArgs('grok', 'xhigh')).toEqual(['--effort', 'xhigh']);
    expect(reviewerEffortArgs('grok', 'max')).toEqual([]);
    expect(reviewerEffortArgs('copilot', 'high')).toEqual([]);
    expect(reviewerEffortArgs('claude', null)).toEqual([]);
  });

  it('NEVER emits --effort for cursor, at any level — the CLI has no such flag', () => {
    // `cursor-agent --effort high` exits non-zero. Cursor's ladder exists so the
    // level can be PICKED; `reviewerModelArg` is what carries it. A regression
    // here reaches an agent as a literal command line it runs verbatim.
    for (const level of CURSOR_EFFORT_LEVELS) {
      expect(reviewerEffortArgs('cursor', level), level).toEqual([]);
      expect(reviewerEffortArgs('cursor-agent', level), level).toEqual([]);
    }
    expect(reviewerEffortArgs('cursor', 'minimal')).toEqual([]);
  });

  it('folds a cursor effort into --model, leaving every other reviewer id verbatim', () => {
    // Cursor's native model-variant syntax, matching slashdo's own fold so the
    // same pin means the same invocation on either side.
    expect(reviewerModelArg('cursor', 'gpt-5', 'max')).toBe('gpt-5[effort=max]');
    // An existing bracket gains an `,effort=` parameter, not a second bracket.
    expect(reviewerModelArg('cursor', 'claude-opus-4-7[thinking=true]', 'high'))
      .toBe('claude-opus-4-7[thinking=true,effort=high]');
    // A model that already names its own effort wins over the ladder pin.
    expect(reviewerModelArg('cursor', 'gpt-5[effort=low]', 'max')).toBe('gpt-5[effort=low]');
    // No effort pinned, or one cursor's ladder rejects → the bare id.
    expect(reviewerModelArg('cursor', 'gpt-5')).toBe('gpt-5');
    expect(reviewerModelArg('cursor', 'gpt-5', 'minimal')).toBe('gpt-5');
    // No model to attach the variant to → nothing at all.
    expect(reviewerModelArg('cursor', '', 'max')).toBeNull();
    expect(reviewerModelArg('cursor', null, 'max')).toBeNull();
    // The alias resolves like every other lookup here.
    expect(reviewerModelArg('cursor-agent', 'gpt-5', 'max')).toBe('gpt-5[effort=max]');
    // Every other reviewer keeps its id verbatim — its effort rides its own flag.
    expect(reviewerModelArg('codex', 'gpt-5.6-sol', 'high')).toBe('gpt-5.6-sol');
    expect(reviewerModelArg('antigravity', 'Gemini 3.5 Flash (High)', 'high')).toBe('Gemini 3.5 Flash (High)');
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

  it('builds the hand-invocation note only for CLI reviewers carrying an effort', () => {
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
    // …including when it carries a MODEL pin too: a local reviewer names no
    // binary, so there is no command line to print (a `null --model …` would be
    // handed to an agent as something to run).
    expect(buildReviewerEffortNote(['ollama'], { ollama: 'high' }, { reviewerModels: { ollama: 'qwen2.5:7b' } })).toBe('');
    expect(buildReviewerEffortNote(['copilot'], { copilot: 'high' }, { reviewerModels: { copilot: 'x' } })).toBe('');
  });

  it('names cursor with its folded --model instead of an --effort it would reject', () => {
    const note = buildReviewerEffortNote(['cursor'], { cursor: 'max' }, { reviewerModels: { cursor: 'gpt-5' } });
    expect(note).toContain('`cursor-agent --model gpt-5[effort=max]`');
    expect(note).not.toContain('--effort');
    // No model to fold into: nothing is emitted rather than a bogus flag.
    expect(buildReviewerEffortNote(['cursor'], { cursor: 'max' })).toBe('');
    expect(buildReviewerEffortNote(['cursor'], { cursor: 'max' }, { reviewerModels: {} })).toBe('');
    // A model with NO effort pin is not this sentence's business.
    expect(buildReviewerEffortNote(['cursor'], {}, { reviewerModels: { cursor: 'gpt-5' } })).toBe('');
    // The pin still round-trips through the emitted --review-with token, which
    // suppresses the note exactly as it does for every other reviewer.
    const reviewWith = buildReviewWithArgs(['cursor'], { reviewerModels: { cursor: 'gpt-5' }, reviewerEfforts: { cursor: 'max' } });
    expect(reviewWith).toContain('cursor[gpt-5]~effort=max');
    expect(buildReviewerEffortNote(['cursor'], { cursor: 'max' }, { reviewWith, reviewerModels: { cursor: 'gpt-5' } })).toBe('');
  });

  it('goes SILENT once the emitted --review-with carries the effort itself', () => {
    // slashdo has parsed `~effort=<level>` since v3.31, and markSuffixes emits it —
    // so on a pinned invocation the loop already runs the reviewer at that effort.
    // Repeating it as prose tells the agent to pass the flag a second time, or to
    // hand-run a reviewer `/do:pr` was about to run.
    const reviewWith = buildReviewWithArgs(['codex', 'claude'], { reviewerEfforts: { codex: 'high', claude: 'low' } });
    expect(reviewWith).toContain('codex~effort=high');
    expect(buildReviewerEffortNote(['codex', 'claude'], { codex: 'high', claude: 'low' }, { reviewWith })).toBe('');
    // An invocation that pins reviewers but NO effort leaves the note as the only
    // carrier, and an absent/blank pin is the unpinned case.
    const noEffort = buildReviewWithArgs(['codex', 'claude'], {});
    expect(noEffort).not.toContain('~effort=');
    expect(buildReviewerEffortNote(['codex'], { codex: 'high' }, { reviewWith: noEffort })).toContain('`codex -c model_reasoning_effort=high`');
    expect(buildReviewerEffortNote(['codex'], { codex: 'high' }, { reviewWith: '' })).toContain('`codex -c model_reasoning_effort=high`');
    // And a lone copilot can't carry an effort at all (no ladder — see the DROPS
    // test above), which is why the lone-default suppression stays correct without
    // an effort clause of its own in applySlashdoInvocation.
    expect(buildReviewWithArgs(['copilot'], { reviewerEfforts: { copilot: 'high' } })).toBe('');
  });

  it('never claims --review-with lacks an effort suffix', () => {
    // The note predates slashdo's `~effort=` support and used to justify itself
    // with "`--review-with` has no effort suffix". It does have one — an agent
    // reading that next to its own `codex~effort=high` token is being misled.
    const note = buildReviewerEffortNote(['codex'], { codex: 'high' });
    expect(note).not.toContain('has no effort suffix');
    expect(note).toContain('Pass the flag yourself when you spawn the reviewer');
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
    expect(sanitizeTaskMetadata({ reviewerEfforts: { claude: 'high', grok: 'max' } }))
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
describe('client mirror of the reviewer vocabulary', () => {
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

  // Same failure mode one column over: a reviewer the picker offers a Model cell
  // for but the server drops the pin from (or vice versa — a CLI whose `--model`
  // the UI hides). The two rosters drove `antigravity` out of sync until #3728.
  it('matches the server model-pin rosters', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect([...client.MODEL_CAPABLE_CLI_REVIEWERS].sort()).toEqual([...MODEL_CAPABLE_CLI_REVIEWERS].sort());
    expect([...client.MODEL_SELECTABLE_REVIEWERS].sort()).toEqual([...MODEL_SELECTABLE_REVIEWERS].sort());
  });

  // The roster itself. A reviewer added on one side only is the `antigravity`
  // drift of #3728: the picker offers a reviewer the server's enum rejects (the
  // save 400s), or the server gains one the user can never select.
  it('matches the server reviewer roster', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect([...client.REVIEWER_VALUES].sort()).toEqual([...REVIEWER_VALUES].sort());
  });

  // Aliases resolve slugs already stored on tasks (`gemini`, `cursor-agent`). One
  // dropped client-side turns a saved reviewer into a row the picker can't render.
  it('matches the server reviewer aliases', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect(client.REVIEWER_ALIASES).toEqual(REVIEWER_ALIASES);
  });

  // Defaults and caps. A cap the input offers above the server's ceiling is
  // silently dropped on save, which reads to the user as the field not working.
  it('matches the server defaults and caps', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect(client.DEFAULT_REVIEWER).toBe(DEFAULT_REVIEWER);
    expect(client.DEFAULT_REVIEWERS).toEqual(DEFAULT_REVIEWERS);
    expect(client.MAX_REVIEWER_MAX_ROUNDS).toBe(MAX_REVIEWER_MAX_ROUNDS);
    expect(client.MAX_REVIEW_USERNAMES).toBe(MAX_REVIEW_USERNAMES);
  });

  // The override roster decides two things that must agree: the picker's "Use
  // system Code Review Defaults" reset (client) removes exactly these keys, and
  // the claim-reviewer lookup (server) calls a task an override when any is
  // present. A key on one side only means the reset leaves a pin behind while
  // the lookup keeps reporting `task-override` for a task the user just cleared.
  it('matches the server reviewer-override key rosters and predicate', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect(client.REVIEWER_OVERRIDE_KEYS).toEqual([...REVIEWER_OVERRIDE_KEYS]);
    expect(client.REVIEWER_LIST_OVERRIDE_KEYS).toEqual([...REVIEWER_LIST_OVERRIDE_KEYS]);
    // The predicate too, not just the roster: "presence, not truthiness" is the
    // half that is easy to get wrong, and a client copy that used `||` would
    // silently disagree about whether an explicitly-cleared pin is an override.
    for (const metadata of [
      { reviewers: ['codex'] }, { optionalReviewers: [] }, { reviewerModels: {} },
      { reviewStopMode: 'on-clean' }, { reviewerApplies: true }, { claimFlow: true }, null, [],
    ]) {
      expect(client.hasReviewerOverride(metadata)).toBe(hasReviewerOverride(metadata));
    }
  });

  // Stop modes: the client rows carry UI copy, but their `value`s are the enum
  // the save is validated against. An extra row 400s the whole task update.
  it('matches the server review stop modes', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    expect(client.REVIEW_STOP_MODES.map(m => m.value)).toEqual([...REVIEW_STOP_MODES]);
    expect(client.DEFAULT_REVIEW_STOP_MODE).toBe(DEFAULT_REVIEW_STOP_MODE);
  });

  // The username pattern and cap are two independent facts, and neither side's
  // own tests can see a divergence — only running the same inputs through both
  // normalizers can. The 25 valid entries exercise the cap, the rest the pattern.
  it('normalizes review usernames identically to the server', async () => {
    const client = await import('../../client/src/lib/reviewerPins.js');
    const cases = [
      ['@octocat'],
      ['org/team'],
      ['bad name'],
      ['-lead'],
      ['octocat', 'OCTOCAT', '@octocat'],
      ['a'.repeat(40)],
      ['', '   ', null, 42, undefined],
      Array.from({ length: 25 }, (_, i) => `reviewer-${i}`),
    ];
    for (const input of cases) {
      expect(client.normalizeReviewUsernames(input)).toEqual(normalizeReviewUsernames(input));
    }
    expect(client.normalizeReviewUsernames('not-an-array')).toEqual(normalizeReviewUsernames('not-an-array'));
  });
});

describe('per-reviewer model pins', () => {
  it('accepts Cursor Agent in the reviewer config and persists its model pin', () => {
    const parsed = codeReviewSettingsSchema.parse({ reviewers: ['cursor-agent'], cursorModel: 'gpt-5' });
    expect(parsed.reviewers).toEqual(['cursor']);
    expect(parsed.cursorModel).toBe('gpt-5');
    expect(reviewerModelsFromDefaults(parsed)).toEqual({ cursor: 'gpt-5' });
  });

  it('keeps an antigravity model pin on the code-review settings slice', () => {
    // `agy --model <id>` is real (unlike the effort-only support PortOS assumed
    // before #3728), so the scalar has to survive the `.strict()` schema.
    expect(codeReviewSettingsSchema.parse({ antigravityModel: 'gemini-3.6-flash' }).antigravityModel)
      .toBe('gemini-3.6-flash');
    // Structural characters would corrupt the emitted `antigravity[<model>]` token.
    expect(codeReviewSettingsSchema.parse({ antigravityModel: 'a,b' }).antigravityModel).toBeUndefined();
    expect(codeReviewSettingsSchema.parse({ antigravityModel: '  ' }).antigravityModel).toBeUndefined();
  });

  it('carries an antigravity model through the task schema and the sanitizer', () => {
    expect(createCosTaskSchema.parse({ description: 'x', reviewerModels: { antigravity: 'gemini-3.6-pro' } }).reviewerModels)
      .toEqual({ antigravity: 'gemini-3.6-pro' });
    expect(sanitizeTaskMetadata({ reviewerModels: { antigravity: 'gemini-3.6-pro', copilot: 'x' } }))
      .toEqual({ reviewerModels: { antigravity: 'gemini-3.6-pro' } });
  });

  it('splits an effort-suffixed antigravity id into a model/effort pair agy accepts', () => {
    expect(pairReviewerModelsAndEfforts({ antigravity: 'gemini-3.6-flash-high' }, {}))
      .toEqual({ reviewerModels: { antigravity: 'gemini-3.6-flash' }, reviewerEfforts: { antigravity: 'high' } });
    // An explicitly pinned effort wins over the one baked into the id.
    expect(pairReviewerModelsAndEfforts({ antigravity: 'gemini-3.6-flash-high' }, { antigravity: 'low' }))
      .toEqual({ reviewerModels: { antigravity: 'gemini-3.6-flash' }, reviewerEfforts: { antigravity: 'low' } });
    // …but an UNUSABLE stored effort doesn't get to suppress the baked one.
    expect(pairReviewerModelsAndEfforts({ antigravity: 'gemini-3.6-flash-low' }, { antigravity: 'max' }))
      .toEqual({ reviewerModels: { antigravity: 'gemini-3.6-flash' }, reviewerEfforts: { antigravity: 'low' } });
  });

  it('leaves unsuffixed ids and every other reviewer untouched', () => {
    expect(pairReviewerModelsAndEfforts({ antigravity: 'gemini-3.6-flash', codex: 'gpt-5.6-sol' }, { codex: 'high' }))
      .toEqual({
        reviewerModels: { antigravity: 'gemini-3.6-flash', codex: 'gpt-5.6-sol' },
        reviewerEfforts: { codex: 'high' }
      });
    // A `-high` suffix on a NON-agy reviewer is part of the id, not an effort.
    expect(pairReviewerModelsAndEfforts({ claude: 'qwen2.5:7b-high' }, {}))
      .toEqual({ reviewerModels: { claude: 'qwen2.5:7b-high' }, reviewerEfforts: {} });
    expect(pairReviewerModelsAndEfforts(undefined, undefined))
      .toEqual({ reviewerModels: {}, reviewerEfforts: {} });
  });

  it('does not mutate the maps it was handed', () => {
    const models = { antigravity: 'gemini-3.6-flash-high' };
    const efforts = {};
    pairReviewerModelsAndEfforts(models, efforts);
    expect(models).toEqual({ antigravity: 'gemini-3.6-flash-high' });
    expect(efforts).toEqual({});
  });

  // #3729: `grok --model <id>` is real and slashdo accepts a `grok[<model>]`
  // bracket, but `grok` was absent from the roster, so every grok review ran on
  // the CLI's own default and the picker rendered "Grok takes no model".
  it('keeps a grok model pin on the code-review settings slice', () => {
    expect(codeReviewSettingsSchema.parse({ grokModel: 'grok-code-fast-1' }).grokModel)
      .toBe('grok-code-fast-1');
    // Structural characters would corrupt the emitted `grok[<model>]` token.
    expect(codeReviewSettingsSchema.parse({ grokModel: 'a]b' }).grokModel).toBeUndefined();
    expect(codeReviewSettingsSchema.parse({ grokModel: '  ' }).grokModel).toBeUndefined();
  });

  it('carries a grok model through the task schema, sanitizer and defaults adapter', () => {
    expect(createCosTaskSchema.parse({ description: 'x', reviewerModels: { grok: 'grok-code-fast-1' } }).reviewerModels)
      .toEqual({ grok: 'grok-code-fast-1' });
    expect(sanitizeTaskMetadata({ reviewerModels: { grok: 'grok-code-fast-1', copilot: 'x' } }))
      .toEqual({ reviewerModels: { grok: 'grok-code-fast-1' } });
    expect(reviewerModelsFromDefaults({ grokModel: 'grok-code-fast-1' })).toEqual({ grok: 'grok-code-fast-1' });
  });

  it('emits the grok pin as a slashdo bracket, and never splits an effort off it', () => {
    expect(buildReviewWithArgs(['grok'], { reviewerModels: { grok: 'grok-code-fast-1' } }))
      .toBe('--review-with grok[grok-code-fast-1]');
    // Only agy bakes an effort into the model id. A grok id passes through whole,
    // and a bare model pin adds no effort pin — grok carries its level on its own
    // flag, not inside the model id.
    expect(pairReviewerModelsAndEfforts({ grok: 'grok-code-fast-1' }, {}))
      .toEqual({ reviewerModels: { grok: 'grok-code-fast-1' }, reviewerEfforts: {} });
    expect(reviewerEffortLevels('grok')).toEqual(GROK_EFFORT_LEVELS);
  });
});

describe('reviewer pin note (saved slashdo defaults must not win)', () => {
  it('names the resolved list AND the exact --review-with text to pass', () => {
    const note = buildReviewerPinNote('codex,claude');
    // Both halves matter: the list the phases run by hand, and the flag text for
    // the moment the agent reaches for a slashdo command instead.
    expect(note).toContain('`codex,claude`');
    expect(note).toContain('--review-with codex,claude');
    expect(note).toContain('/do:pr');
    // The failure mode this block exists to prevent, named so the agent can
    // recognize it: a bare invocation silently adopting the host's saved config.
    expect(note).toMatch(/\.slashdo-config\.json/);
  });

  it('carries the per-entry suffixes verbatim so the pinned model/effort survive the paste', () => {
    // A reviewer pin is only honored if the agent pastes the whole token — the
    // bracket and the ~suffixes ARE the model/optional/cap/effort pins.
    const csv = 'antigravity[gemini-3.7-flash]~opt~max=1~effort=medium';
    expect(buildReviewerPinNote(csv)).toContain(`--review-with ${csv}`);
  });

  it('keeps a PortOS-served reviewer OUT of the pinned flag — slashdo aborts on a slug it does not know', () => {
    const note = buildReviewerPinNote('lmstudio~effort=high,ollama,@alice');
    // The flag text carries only tokens slashdo can parse...
    expect(note).toContain('--review-with ollama,@alice');
    expect(note).not.toContain('--review-with lmstudio');
    // ...and the dropped reviewer is named by bare slug, pointed at the
    // procedure that actually runs it, so dropping it from a slashdo call can't
    // read as permission to skip the review.
    expect(note).toContain('PortOS runs `lmstudio` itself');
    expect(note).toContain('Local Reviewer Procedure');
  });

  it('states the pin with no flag text at all when every reviewer is PortOS-only', () => {
    const note = buildReviewerPinNote('lmstudio');
    expect(note).toContain('authoritative');
    // No flag to hand out — the only `--review-with` mention left is the
    // prohibition, never an instruction to pass one.
    expect(note).not.toMatch(/pass `--review-with/);
  });

  it('reads back every slug an emitted token can carry (inverse of markSuffixes)', () => {
    // reviewerTokenSlug is the only place the emitted grammar is parsed rather
    // than built. Round-trip a fully decorated token through the real emitter so
    // a new bracket or ~suffix in markSuffixes fails HERE instead of silently
    // mis-slugging a reviewer out of (or into) the pinned flag.
    const csv = buildReviewersCsv(
      ['antigravity', 'lmstudio'],
      ['alice'],
      ['antigravity'],
      { antigravity: 1 },
      { antigravity: 'gemini-3.7-flash', lmstudio: 'qwen' },
      { antigravity: 'medium', lmstudio: 'high' }
    );
    expect(csv.split(',').map(reviewerTokenSlug)).toEqual(['antigravity', 'lmstudio', '@alice']);
  });

  it('emits nothing when there is no list to pin', () => {
    expect(buildReviewerPinNote('')).toBe('');
    expect(buildReviewerPinNote('   ')).toBe('');
    expect(buildReviewerPinNote(null)).toBe('');
    expect(buildReviewerPinNote(undefined)).toBe('');
  });
});

// The claim generators resolve reviewers BEFORE a task record exists and render
// the CSV into `{reviewers}`; the prompt builder re-resolves them from the
// persisted task at spawn time to emit the reviewer pin. Those two resolutions
// have to land on the same list, or the pin names reviewers the prompt does not
// (#4770). `reviewerConfigMetadata` is the round-trip that makes them agree.
describe('claim reviewer round-trip (prompt CSV ↔ persisted metadata)', () => {
  const defaults = {
    reviewers: ['copilot'],
    usernames: ['alice'],
    optionalReviewers: ['ollama'],
    reviewerMaxRounds: { codex: 2 },
    antigravityModel: 'gemini-3.7-flash-high',
    codexEffort: 'high'
  };

  it('claimSafeReviewers drops copilot and never falls back to it', () => {
    expect(claimSafeReviewers(['codex', 'copilot'])).toEqual(['codex']);
    expect(claimSafeReviewers(['copilot'])).toEqual(['codex']);
    expect(claimSafeReviewers([])).toEqual(['codex']);
    expect(claimSafeReviewers(undefined)).toEqual(['codex']);
  });

  it('stably prioritizes tool-free local reviewers ahead of tool-enabled reviewers', () => {
    expect(prioritizeToolFreeReviewers(['codex', 'ollama', 'copilot', 'lmstudio', 'claude']))
      .toEqual(['ollama', 'lmstudio', 'codex', 'copilot', 'claude']);
    expect(resolveReviewerConfig({ reviewers: ['codex', 'ollama'] }, null, null).reviewers)
      .toEqual(['ollama', 'codex']);
  });

  it('resolves through the claim guard from every input shape a claim task can carry', () => {
    // The install default is the fallback, the claim guard is applied after it,
    // and legacy single-`reviewer` metadata still resolves.
    expect(resolveClaimReviewerConfig({}, null, undefined).reviewers).toEqual(['codex']);
    expect(resolveClaimReviewerConfig({ reviewers: ['copilot'] }, null, ['copilot']).reviewers).toEqual(['codex']);
    expect(resolveClaimReviewerConfig({}, null, ['claude', 'copilot']).reviewers).toEqual(['claude']);
    expect(resolveClaimReviewerConfig({ reviewer: 'grok' }, null, ['claude']).reviewers).toEqual(['grok']);
  });

  it('resolveClaimReviewerConfig emits a CSV matching its own resolved bundle', () => {
    const config = resolveClaimReviewerConfig({ reviewers: ['codex', 'antigravity'] }, defaults, defaults.reviewers);
    expect(config.reviewers).toEqual(['codex', 'antigravity']);
    expect(config.csv).toBe(buildReviewersCsv(
      config.reviewers, config.usernames, config.optionalReviewers,
      config.reviewerMaxRounds, config.reviewerModels, config.reviewerEfforts
    ));
    // The agy model id's baked tier is split off exactly once — resolving the
    // persisted config a second time must not re-split or double-apply it.
    expect(config.reviewerModels.antigravity).toBe('gemini-3.7-flash');
    expect(config.reviewerEfforts.antigravity).toBe('high');
  });

  it('persisting reviewerConfigMetadata makes the SECOND resolution reproduce the first CSV', () => {
    // Round 1: the generator, with no task record yet.
    const generated = resolveClaimReviewerConfig({ reviewers: ['codex', 'antigravity'] }, defaults, defaults.reviewers);
    const metadata = { claimFlow: true, ...reviewerConfigMetadata(generated) };
    // Round 2: the prompt builder, reading the task back — and deliberately
    // WITHOUT the defaults it would otherwise fall through to, to prove the
    // persisted values are what carry the list.
    const rebuilt = resolveClaimReviewerConfig(metadata, null, null);
    expect(rebuilt.csv).toBe(generated.csv);
    expect(rebuilt).toMatchObject({
      reviewers: generated.reviewers,
      usernames: generated.usernames,
      optionalReviewers: generated.optionalReviewers,
      reviewerMaxRounds: generated.reviewerMaxRounds,
      reviewerModels: generated.reviewerModels,
      reviewerEfforts: generated.reviewerEfforts
    });
    // And the plain (non-claim) resolver the prompt builder shares with the
    // review loop agrees too — that is the resolution #4770 was silently
    // answering from the install-wide defaults.
    expect(resolveReviewerConfig(metadata, null, null).reviewers).toEqual(generated.reviewers);
  });

  it('a DIFFERENT install default cannot override what the task persisted', () => {
    const generated = resolveClaimReviewerConfig({ reviewers: ['grok'] }, defaults, defaults.reviewers);
    const metadata = reviewerConfigMetadata(generated);
    const otherInstall = { reviewers: ['claude'], usernames: ['bob'], optionalReviewers: ['grok'], reviewerMaxRounds: { grok: 9 } };
    expect(resolveClaimReviewerConfig(metadata, otherInstall, otherInstall.reviewers).csv).toBe(generated.csv);
  });

  it('sanitizes rather than trusts: unknown keys and junk values never reach the task record', () => {
    const meta = reviewerConfigMetadata({
      reviewers: ['codex', 'bogus'],
      usernames: ['@Alice', 'bad token'],
      optionalReviewers: ['nope'],
      reviewerMaxRounds: { codex: 'three' },
      reviewerModels: {},
      reviewerEfforts: {},
      swarmCount: 6,
      issueAuthorFilter: 'any'
    });
    expect(meta).toEqual({
      reviewers: ['codex'],
      usernames: ['Alice'],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      reviewerModels: {},
      reviewerEfforts: {}
    });
  });

  it('returns an empty patch rather than null when nothing survives sanitizing', () => {
    // Callers spread this into a task's metadata, so a null would throw at the
    // three claim generators rather than degrade.
    expect(reviewerConfigMetadata(null)).toEqual({});
    expect(reviewerConfigMetadata({ reviewers: ['bogus'] })).toEqual({});
  });
});

describe('reviewerForProvider', () => {
  it('names a CLI reviewer by the binary its provider spawns', () => {
    expect(reviewerForProvider({ id: 'claude-code-tui', command: 'claude' })).toBe('claude');
    expect(reviewerForProvider({ id: 'codex', command: '/opt/homebrew/bin/codex' })).toBe('codex');
    // The stored slug is `antigravity`; the executable is `agy`.
    expect(reviewerForProvider({ id: 'antigravity-cli', command: 'agy' })).toBe('antigravity');
    expect(reviewerForProvider({ id: 'cursor-cli', command: 'cursor-agent' })).toBe('cursor');
  });

  it('names a local-LLM reviewer by provider id (it has no binary at all)', () => {
    expect(reviewerForProvider({ id: 'ollama', type: 'api' })).toBe('ollama');
    expect(reviewerForProvider({ id: 'lmstudio', type: 'api' })).toBe('lmstudio');
    expect(reviewerForProvider({ id: 'mtplx', type: 'api' })).toBe('mtplx');
  });

  it('follows the wrapper binary for a locally-served CLI provider', () => {
    // A locally-served `claude` reviews as `claude`: same binary, same env, and
    // its model pin is free text precisely so a local id can be named.
    expect(reviewerForProvider({ id: 'claude-ollama', command: 'claude', ollamaBacked: true })).toBe('claude');
    expect(reviewerForProvider({ id: 'opencode-vllm', command: 'opencode' })).toBe('opencode');
  });

  it('returns null for a provider the Review Loop cannot run', () => {
    // A hosted API provider spawns nothing and is not a local backend.
    expect(reviewerForProvider({ id: 'openrouter', type: 'api' })).toBeNull();
    expect(reviewerForProvider({ id: 'mystery', command: 'some-unknown-agent' })).toBeNull();
    expect(reviewerForProvider(null)).toBeNull();
    expect(reviewerForProvider('claude')).toBeNull();
  });
});

describe('codeReviewDefaultsFromProvider', () => {
  it('carries the provider model and effort onto its reviewer', () => {
    expect(codeReviewDefaultsFromProvider({
      id: 'claude-code', command: 'claude', defaultModel: 'claude-opus-5', effort: 'high',
    })).toEqual({ reviewer: 'claude', model: 'claude-opus-5', effort: 'high' });
  });

  it('drops a configured-default sentinel — it is a marker, not a model id', () => {
    const out = codeReviewDefaultsFromProvider({ id: 'grok-cli', command: 'grok', defaultModel: 'grok-configured-default' });
    expect(out).toEqual({ reviewer: 'grok', model: null, effort: null });
  });

  it('drops an effort the reviewer\'s own ladder rejects', () => {
    // agy really does reject `--effort max`; reviewing at a silently different
    // level than the one configured is worse than using its own default.
    expect(codeReviewDefaultsFromProvider({
      id: 'antigravity-cli', command: 'agy', defaultModel: 'gemini-3.6-flash', effort: 'max',
    }).effort).toBeNull();
    // A provider with no effort set at all leaves the reviewer at its own default.
    expect(codeReviewDefaultsFromProvider({ id: 'codex', command: 'codex' }).effort).toBeNull();
    // ...as does a value that is not an effort level in the first place.
    expect(codeReviewDefaultsFromProvider({ id: 'codex', command: 'codex', effort: 'turbo' }).effort).toBeNull();
  });

  it('returns null when the provider maps to no reviewer', () => {
    expect(codeReviewDefaultsFromProvider({ id: 'openrouter', type: 'api' })).toBeNull();
    expect(codeReviewDefaultsFromProvider(null)).toBeNull();
  });
});

// `hasReviewerOverride` is what a claim-reviewer lookup reports as its `source`,
// and the user acts on that answer ("clear the override" vs "change the
// defaults"). The interesting cases are the ones truthiness gets wrong.
describe('hasReviewerOverride', () => {
  it('reports an override for any key that can change the resolved list', async () => {
    for (const key of REVIEWER_LIST_OVERRIDE_KEYS) {
      expect(hasReviewerOverride({ [key]: undefined })).toBe(true);
    }
  });

  it('ignores the two slashdo run flags — a claim has no flag string to put them in', () => {
    // `resolveReviewerConfig` never reads them, so a task whose only reviewer key
    // is a stop-mode resolves its whole list from the defaults. Calling that an
    // override sends the user to clear a pin that is not supplying what they see.
    expect(REVIEWER_OVERRIDE_KEYS).toContain('reviewStopMode');
    expect(hasReviewerOverride({ reviewStopMode: 'on-clean', reviewerApplies: true })).toBe(false);
  });

  it('treats an explicitly EMPTY pin as an override — it clears the defaults value', () => {
    // `[]`/`{}` are the shape a user gets by unmarking every optional reviewer or
    // clearing every model pin. Gating on truthiness would call that "unset" and
    // send them to the Code Reviewers panel, which is not where the value they
    // are seeing comes from.
    expect(hasReviewerOverride({ optionalReviewers: [] })).toBe(true);
    expect(hasReviewerOverride({ reviewerModels: {} })).toBe(true);
  });

  it('reports no override for task metadata that only carries non-reviewer options', () => {
    expect(hasReviewerOverride({ useWorktree: false, openPR: false, claimFlow: true, simplify: true })).toBe(false);
    expect(hasReviewerOverride({ reviewLoop: true, issueAuthorFilter: 'owner' })).toBe(false);
  });

  it('reports no override for a non-object', () => {
    for (const value of [null, undefined, [], 'reviewers', 7]) {
      expect(hasReviewerOverride(value)).toBe(false);
    }
  });
});

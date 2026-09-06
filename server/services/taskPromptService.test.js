import { describe, it, expect, vi, afterEach } from 'vitest';

// Drive getTaskPrompt with a controlled template so the REAL
// resolvePromptPlaceholders (and the real PATHS.worktrees) do the work, without
// touching persisted schedule state. getTaskInterval is the only taskSchedule
// export taskPromptService imports.
vi.mock('./taskSchedule.js', () => ({
  getTaskInterval: vi.fn(async () => ({ prompt: 'before {worktreesRoot}/claim-x after' })),
}));

// Stand-in slashdo bodies. Every one carries the `$`-prefixed tokens that
// String.replace treats as backreferences when handed a STRING replacement —
// `$&` (the match), `$1`, and the "text before / after the match" forms — so a
// regression to string-form replacement shows up as spliced prompt text rather
// than passing by luck on a body that happens to contain no `$`.
const { BACKREFERENCE_BAIT } = vi.hoisted(() => ({ BACKREFERENCE_BAIT: "regex `^[^/]+#[0-9]+$` and $& and $1 and $' end" }));
vi.mock('../lib/slashdoLoader.js', () => ({
  loadSlashdoFile: vi.fn(async (name) => (
    name === 'review'
      ? `FULL /do:review BODY ## Parse Arguments ## Copilot Code Review Loop ${BACKREFERENCE_BAIT}`
      : name === 'replan'
        ? `REPLAN BODY ${BACKREFERENCE_BAIT}`
        : ''
  )),
  loadSlashdoLib: vi.fn(async (name) => `# ${name} lens\n${BACKREFERENCE_BAIT}`),
}));

import { getTaskPrompt, getStagePrompt, DEFAULT_TASK_PROMPTS, PREVIOUS_DEFAULT_PROMPTS } from './taskPromptService.js';
import { getTaskInterval } from './taskSchedule.js';
import { loadSlashdoFile, loadSlashdoLib } from '../lib/slashdoLoader.js';
import { PATHS } from '../lib/fileUtils.js';

describe('taskPromptService {worktreesRoot} substitution', () => {
  it('resolves {worktreesRoot} to PATHS.worktrees (PortOS shared dir), leaving no literal placeholder', async () => {
    // PATHS.worktrees is PortOS's own shared worktrees dir — an absolute path
    // ending in data/cos/worktrees — NOT a repo-relative one.
    // Accept either separator: PATHS.worktrees is composed with path.join, so
    // it ends in `data\cos\worktrees` on Windows.
    expect(PATHS.worktrees).toMatch(/[\\/]data[\\/]cos[\\/]worktrees$/);

    const out = await getTaskPrompt('claim-issue');
    expect(out).toBe(`before ${PATHS.worktrees}/claim-x after`);
    expect(out).not.toContain('{worktreesRoot}');
  });
});

describe('slashdo placeholder substitution', () => {
  const PR_REVIEWER_INTERVAL = {
    prompt: null,
    taskMetadata: {
      pipeline: {
        stages: [
          { name: 'Security Scan', promptKey: 'pr-reviewer-security' },
          { name: 'Eligibility Gate', promptKey: 'pr-reviewer-eligibility' },
          { name: 'Code Review & Merge', promptKey: 'pr-reviewer-review' },
        ],
      },
    },
  };

  it('inlines a slashdo body verbatim — backreference tokens in it never splice the prompt', async () => {
    getTaskInterval.mockResolvedValueOnce({ prompt: 'HEAD {reviewChecklist} TAIL {slashdoReplan} END' });

    const out = await getTaskPrompt('code-reviewer');

    // The 2026-09-04 shape of this bug: a `$` + backtick inside the inlined
    // /do:review re-inserted everything before the placeholder, so one Stage 3
    // prompt carried seven copies of its own header (~400KB, ~100K tokens).
    expect(out).toBe(`HEAD FULL /do:review BODY ## Parse Arguments ## Copilot Code Review Loop ${BACKREFERENCE_BAIT} TAIL REPLAN BODY ${BACKREFERENCE_BAIT} END`);
    expect(out.match(/HEAD/g)).toHaveLength(1);
  });

  it('gives the public-review actions stage the review LENSES ({reviewLenses}), never the whole /do:review procedure', async () => {
    getTaskInterval.mockResolvedValueOnce(PR_REVIEWER_INTERVAL);
    vi.mocked(loadSlashdoFile).mockClear();
    vi.mocked(loadSlashdoLib).mockClear();

    const stage = await getStagePrompt('pr-reviewer', 2);

    // The stage header appears once (no splice) and the checklist is the lens
    // set — the argument parser, reviewer loops and PR-posting procedure of the
    // full body are a runtime this sandboxed, network-less stage cannot use.
    expect(stage.match(/PR Code Review & Actions \(Stage 3\)/g)).toHaveLength(1);
    expect(stage).not.toContain('{reviewLenses}');
    expect(stage).not.toContain('FULL /do:review BODY');
    expect(stage).toContain('# review-surface-scan lens');
    expect(stage).toContain('# review-security-audit lens');
    expect(stage).toContain('# review-cross-file-contract lens');
    expect(stage).toContain(BACKREFERENCE_BAIT);
    expect(vi.mocked(loadSlashdoFile)).not.toHaveBeenCalledWith('review', expect.anything());
    expect(vi.mocked(loadSlashdoLib).mock.calls.map(([name]) => name)).toEqual([
      'review-surface-scan',
      'review-surface-quality',
      'review-security-audit',
      'review-cross-file-tracing',
      'review-cross-file-contract',
    ]);
  });

  it('keeps {reviewChecklist} as the full /do:review body for stored and prior-default prompts', async () => {
    getTaskInterval.mockResolvedValueOnce({ prompt: 'X {reviewChecklist} Y' });

    const out = await getTaskPrompt('code-reviewer');

    expect(out).toContain('FULL /do:review BODY');
    expect(out).not.toContain('lens');
  });
});

describe('claim-flow prompt variants', () => {
  it('keeps scheduled plan-task review-free while manual PLAN claims retain review guidance', async () => {
    getTaskInterval.mockResolvedValue({ prompt: null });

    const scheduled = await getTaskPrompt('plan-task');
    const manual = await getTaskPrompt('plan-task', { claimFlow: true });

    expect(scheduled).not.toContain('## Phase 6 — Review locally');
    expect(scheduled).toContain('gh pr checks <num> --required --watch --fail-fast');
    const expectedManual = PREVIOUS_DEFAULT_PROMPTS['plan-task'].at(-1)
      .replace(/\{worktreesRoot\}/g, PATHS.worktrees);
    expect(manual).toBe(expectedManual);
    expect(manual).toContain('## Phase 6 — Review locally');
    expect(manual).toContain('{reviewers}');
  });

  it('treats a persisted shipped default as non-customized for manual PLAN claims', async () => {
    getTaskInterval.mockResolvedValue({ prompt: DEFAULT_TASK_PROMPTS['plan-task'], promptVersion: 18 });

    const manual = await getTaskPrompt('plan-task', { claimFlow: true });

    expect(manual).toContain('## Phase 6 — Review locally');
    expect(manual).toContain('{reviewers}');
  });

  it('preserves a genuinely customized persisted prompt for manual claims', async () => {
    getTaskInterval.mockResolvedValue({ prompt: 'custom claim prompt' });

    await expect(getTaskPrompt('plan-task', { claimFlow: true })).resolves.toBe('custom claim prompt');
  });
});

// A pipeline STAGE body (pr-reviewer-security, code-reviewer-review, …) is read
// straight out of the catalog by its promptKey — it is never persisted and never
// versioned, which is why editing one takes no PROMPT_VERSIONS bump and no
// PREVIOUS_DEFAULT_PROMPTS entry (see taskPromptDefaults.test.js). That decision
// is only safe while stage resolution ignores stored schedule state, so pin the
// behavior rather than restating the absent constant: hand getStagePrompt an
// interval carrying a STALE persisted prompt and assert the current catalog body
// still wins.
describe('getStagePrompt reads stage bodies from the catalog, not from stored state', () => {
  it('ignores a stale persisted prompt on the pipeline task and returns the current stage default', async () => {
    getTaskInterval.mockResolvedValueOnce({
      prompt: 'STALE PERSISTED BODY that an install upgraded past long ago',
      promptVersion: 1,
      taskMetadata: {
        pipeline: {
          stages: [
            { name: 'Security Scan', promptKey: 'pr-reviewer-security' },
            { name: 'Code Review & Merge', promptKey: 'pr-reviewer-review' },
          ],
        },
      },
    });

    const stage = await getStagePrompt('pr-reviewer', 0);
    // Byte-identical, not merely similar: resolvePromptPlaceholders only rewrites
    // {worktreesRoot} / {reviewChecklist} / {slashdoReplan}, none of which this
    // body carries, so nothing stands between the catalog and the caller.
    expect(stage).toBe(DEFAULT_TASK_PROMPTS['pr-reviewer-security']);
    expect(stage).not.toContain('STALE PERSISTED BODY');
  });

  it('falls back to the task prompt only when the stage carries no promptKey', async () => {
    // Queued TWICE on purpose: the fallback path re-enters getTaskInterval via
    // getTaskPrompt, so one …Once would be consumed before the fallback runs and
    // the assertion would read the module-level default instead. …Once (not
    // mockResolvedValue) keeps the override from leaking into later tests.
    const unkeyed = {
      prompt: 'the task-level body',
      taskMetadata: { pipeline: { stages: [{ name: 'Unkeyed' }] } },
    };
    getTaskInterval.mockResolvedValueOnce(unkeyed).mockResolvedValueOnce(unkeyed);

    await expect(getStagePrompt('pr-reviewer', 0)).resolves.toBe('the task-level body');
  });
});

// Every override above is …Once, but reset anyway: a future test that reaches for
// mockResolvedValue would otherwise silently replace the module-level default for
// everything declared after it.
afterEach(() => {
  vi.mocked(getTaskInterval).mockReset();
  vi.mocked(getTaskInterval).mockResolvedValue({ prompt: 'before {worktreesRoot}/claim-x after' });
});

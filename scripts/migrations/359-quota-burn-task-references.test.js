/**
 * Migration 359 — legacy burn plans become scheduled-task references.
 *
 * Fixture-driven and placeholder-only: no value here is copied from a live
 * install (AGENTS.md, Sensitive Data & Privacy). The one real string is a
 * SHIPPED preset prompt, imported from the module that ships it, because
 * recognition is the behaviour under test and a hand-written approximation
 * would assert a rule the product does not have.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './359-quota-burn-task-references.js';
import { QUOTA_BURN_PROMPT_PRESETS, AUDIT_CONTRACT_HEADING } from '../../server/lib/quotaBurnPresets.js';

const uxPreset = QUOTA_BURN_PROMPT_PRESETS.find((preset) => preset.id === 'ux-audit');
const docsPreset = QUOTA_BURN_PROMPT_PRESETS.find((preset) => preset.id === 'docs-audit');

/** A prompt the user edited: the shipped mission with a step of their own added. */
const customizedPrompt = uxPreset.params.prompt.replace(
  AUDIT_CONTRACT_HEADING,
  `${AUDIT_CONTRACT_HEADING}\n\n0. **Also check the onboarding flow.** Our own extra step.`,
);

let root;
const planPath = () => join(root, 'data', 'cos', 'quota-burn.json');
const jobsPath = () => join(root, 'data', 'cos', 'autonomous-jobs.json');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const legacyPlan = () => ({
  enabled: true,
  checkIntervalMinutes: 30,
  families: {
    grok: {
      enabled: true,
      jobs: [
        {
          id: 'step-preset', enabled: true, label: 'Nightly UX sweep', jobType: 'agent-prompt',
          params: { ...uxPreset.params, appId: 'app-example' },
        },
        {
          id: 'step-custom', enabled: false, label: 'House style pass', runOnce: true, jobType: 'agent-prompt',
          params: { appId: 'app-example', prompt: customizedPrompt, useWorktree: true, discardWorktree: true },
        },
        {
          id: 'step-programmatic', enabled: true, jobType: 'universe-bible-images',
          params: { universeId: 'universe-example', maxEntries: 4 },
        },
        {
          id: 'step-no-app', enabled: true, jobType: 'agent-prompt',
          params: { ...docsPreset.params },
        },
      ],
    },
    claude: { enabled: false, jobs: [] },
  },
});

const run = () => migration.up({ rootDir: root });
const steps = () => readJson(planPath()).families.grok.jobs;
const step = (id) => steps().find((entry) => entry.id === id);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'portos-359-'));
  mkdirSync(join(root, 'data', 'cos'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('migration 359', () => {
  it('does nothing when the install has no burn plan — it gates on its INPUT', async () => {
    await expect(run()).resolves.toEqual({ converted: 0 });
    expect(existsSync(planPath())).toBe(false);
    expect(existsSync(jobsPath())).toBe(false);
  });

  it('refuses to run on a corrupt plan rather than recording itself as applied', async () => {
    writeFileSync(planPath(), '{ not json');
    await expect(run()).rejects.toThrow(/not valid JSON/);
  });

  it('maps a recognized shipped preset onto its scheduled counterpart, issues-only', async () => {
    writeJson(planPath(), legacyPlan());
    await run();

    const converted = step('step-preset');
    expect(converted.taskRef).toEqual({ kind: 'builtin', taskType: 'ux', appId: 'app-example' });
    expect(converted.jobType).toBeUndefined();
    // Explicit `true` even though `ux` already defaults to filing: the shipped
    // default is not the promise — the burn was an issues-only audit, and a
    // catalog default that flipped later must not turn it into code work.
    expect(converted.overrides.params.fileIssues).toBe(true);
    // The step's own identity is untouched, so the run-once ledger and every
    // dispatch record still key on it.
    expect(converted).toMatchObject({ id: 'step-preset', enabled: true, label: 'Nightly UX sweep' });
  });

  it('preserves a material execution override on a recognized preset', async () => {
    const plan = legacyPlan();
    plan.families.grok.jobs[0].params.discardWorktree = true;
    writeJson(planPath(), plan);
    await run();
    expect(step('step-preset').overrides.params).toMatchObject({ fileIssues: true, discardWorktree: true });
  });

  it('turns a customized prompt into an on-demand custom task rather than guessing a shipped one', async () => {
    writeJson(planPath(), legacyPlan());
    await run();

    const converted = step('step-custom');
    expect(converted.taskRef).toEqual({ kind: 'custom', jobId: 'job-burn-grok-step-custom' });
    // Disabled and one-shot state belong to the step, and survive the rewrite.
    expect(converted).toMatchObject({ enabled: false, runOnce: true });

    const job = readJson(jobsPath()).jobs.find((entry) => entry.id === 'job-burn-grok-step-custom');
    expect(job.promptTemplate).toBe(customizedPrompt);
    expect(job).toMatchObject({
      name: 'House style pass',
      appId: 'app-example',
      type: 'agent',
      // Disabled FROM THE CLOCK, not from invocation: nothing fires it on a
      // schedule, but the burn can still invoke it, and unattended invocation
      // needs the autonomy level the legacy executor implicitly had.
      interval: 'on-demand',
      intervalMs: null,
      enabled: true,
      autonomyLevel: 'yolo',
    });
    // The posture the retired executor derived at dispatch: a discarded worktree
    // lands no code, so PR + simplify are off and a clean tree is a success.
    expect(job.taskMetadata).toEqual({
      useWorktree: true, openPR: false, simplify: false,
      discardWorktree: true, noCodeOutput: true, worktreeChangesExpected: false,
    });
  });

  it('points the two programmatic types at their scheduled handlers, params intact', async () => {
    writeJson(planPath(), legacyPlan());
    await run();
    const converted = step('step-programmatic');
    expect(converted.taskRef).toEqual({ kind: 'builtin', taskType: 'universe-bible-images', appId: null });
    expect(converted.overrides.params).toEqual({ universeId: 'universe-example', maxEntries: 4 });
  });

  it('keeps a step with no target app as non-runnable instead of retargeting it', async () => {
    // It could not run before (the legacy executor refused "no managed app
    // selected"), so it must not become newly live against PortOS's own
    // checkout. Its text and settings are preserved in a DISABLED custom task.
    writeJson(planPath(), legacyPlan());
    await run();
    expect(step('step-no-app').taskRef).toEqual({ kind: 'custom', jobId: 'job-burn-grok-step-no-app' });
    const job = readJson(jobsPath()).jobs.find((entry) => entry.id === 'job-burn-grok-step-no-app');
    expect(job).toMatchObject({ enabled: false, appId: null });
    expect(job.promptTemplate).toBe(docsPreset.params.prompt);
  });

  it('keeps plan order and leaves other families alone', async () => {
    writeJson(planPath(), legacyPlan());
    await run();
    expect(steps().map((entry) => entry.id)).toEqual(['step-preset', 'step-custom', 'step-programmatic', 'step-no-app']);
    expect(readJson(planPath()).families.claude).toEqual({ enabled: false, jobs: [] });
  });

  it('parks the pre-conversion plan so a misread heuristic stays recoverable', async () => {
    const original = legacyPlan();
    writeJson(planPath(), original);
    await run();
    expect(readJson(join(root, 'data', 'cos', 'quota-burn.pre-359.json'))).toEqual(original);
  });

  it('is idempotent: a second run converts nothing and adds no task', async () => {
    writeJson(planPath(), legacyPlan());
    const first = await run();
    const afterFirst = readJson(planPath());
    const jobsAfterFirst = readJson(jobsPath()).jobs.map((entry) => entry.id);

    const second = await run();

    expect(first.converted).toBe(4);
    expect(second).toMatchObject({ converted: 0 });
    expect(readJson(planPath())).toEqual(afterFirst);
    expect(readJson(jobsPath()).jobs.map((entry) => entry.id)).toEqual(jobsAfterFirst);
  });

  it('resumes an interrupted run without duplicating the custom task', async () => {
    // The crash window the write order exists for: the jobs file landed, the
    // plan did not. Re-running must reuse the job it already created — a second
    // copy would be a duplicate automation the user never configured.
    writeJson(planPath(), legacyPlan());
    await run();
    const jobsAfterCrash = readJson(jobsPath());
    writeJson(planPath(), legacyPlan());

    await run();

    const ids = readJson(jobsPath()).jobs.map((entry) => entry.id);
    expect(ids).toEqual(jobsAfterCrash.jobs.map((entry) => entry.id));
    expect(ids.filter((id) => id === 'job-burn-grok-step-custom')).toHaveLength(1);
    expect(step('step-custom').taskRef).toEqual({ kind: 'custom', jobId: 'job-burn-grok-step-custom' });
  });

  it('never overwrites a custom task the user has since edited', async () => {
    writeJson(planPath(), legacyPlan());
    await run();
    const jobs = readJson(jobsPath());
    const edited = jobs.jobs.find((entry) => entry.id === 'job-burn-grok-step-custom');
    edited.promptTemplate = 'the user rewrote this';
    writeJson(jobsPath(), jobs);
    writeJson(planPath(), legacyPlan());

    await run();

    expect(readJson(jobsPath()).jobs.find((entry) => entry.id === 'job-burn-grok-step-custom').promptTemplate)
      .toBe('the user rewrote this');
  });

  it('appends to an existing jobs file instead of replacing it', async () => {
    writeJson(jobsPath(), { version: 1, lastUpdated: '2020-01-01T00:00:00.000Z', jobs: [{ id: 'job-existing', name: 'Example job' }] });
    writeJson(planPath(), legacyPlan());
    await run();
    expect(readJson(jobsPath()).jobs.map((entry) => entry.id))
      .toEqual(['job-existing', 'job-burn-grok-step-custom', 'job-burn-grok-step-no-app']);
  });

  it('leaves a step that names no convertible work exactly as it is', async () => {
    writeJson(planPath(), { families: { grok: { enabled: true, jobs: [{ id: 'mystery', enabled: true, jobType: 'retired-type', params: { prompt: 'x' } }] } } });
    const result = await run();
    // Counted, not converted and not dropped: `retired-type` is outside the
    // legacy alphabet, so there is no work to point a reference at, and
    // inventing one would spend real quota on something never configured.
    expect(result).toEqual({ converted: 0, unconverted: 1 });
    expect(steps()[0]).toEqual({ id: 'mystery', enabled: true, jobType: 'retired-type', params: { prompt: 'x' } });
  });
});

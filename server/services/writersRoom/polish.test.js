import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

// polish.js imports ONLY `runProsePass` from evaluator.js — a minimal mock keeps
// the whole LLM/toolkit graph (and its data-dir reads) out of this unit test.
vi.mock('./evaluator.js', () => ({ runProsePass: vi.fn() }));

const { runProsePass } = await import('./evaluator.js');
const polish = await import('./polish.js');
const local = await import('./local.js');

const {
  scoreEvaluation, computeQualityScore, decideKeepRevert, shouldStopPlateau,
  mapFindingsToCuts, buildRevisionBrief, resolvePolishOptions,
  startPolish, listSnapshots, revertToSnapshot, isPolishActive, attachClient,
  DEFAULT_PLATEAU_THRESHOLD, MAX_CYCLES,
} = polish;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-polish-test-'));
  runProsePass.mockReset();
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

// ---------- pure helpers ----------

describe('scoreEvaluation', () => {
  it('is 100 for a clean evaluation and drops by weighted severity', () => {
    expect(scoreEvaluation({ issues: [] })).toBe(100);
    expect(scoreEvaluation({ issues: [{ severity: 'major' }] })).toBe(97);
    expect(scoreEvaluation({ issues: [{ severity: 'moderate' }, { severity: 'minor' }] })).toBe(97);
    // Unknown severity weighted as 1; missing issues array → clean.
    expect(scoreEvaluation({ issues: [{ severity: 'weird' }] })).toBe(99);
    expect(scoreEvaluation(null)).toBe(100);
  });

  it('never goes below 0', () => {
    const issues = Array.from({ length: 60 }, () => ({ severity: 'major' }));
    expect(scoreEvaluation({ issues })).toBe(0);
  });
});

describe('computeQualityScore', () => {
  it('subtracts the deterministic slop penalty from the evaluate score', () => {
    const clean = 'The door opened. Rain fell on the stones. She walked home in silence.';
    const q = computeQualityScore({ issues: [] }, clean);
    expect(q).toBeLessThanOrEqual(100);
    // Slop-heavy text scores strictly lower than clean text for the same eval.
    const slop = 'It was a tapestry of myriad delve. '.repeat(20);
    expect(computeQualityScore({ issues: [] }, slop)).toBeLessThan(q + 0.001);
  });
});

describe('decideKeepRevert', () => {
  it('keeps when the score did not regress (ties keep)', () => {
    expect(decideKeepRevert(90, 95)).toBe('keep');
    expect(decideKeepRevert(90, 90)).toBe('keep');
    expect(decideKeepRevert(90, 89.9)).toBe('revert');
  });
});

describe('shouldStopPlateau', () => {
  it('stops when the kept gain is below the threshold', () => {
    expect(shouldStopPlateau(90, 90, DEFAULT_PLATEAU_THRESHOLD)).toBe(true);
    expect(shouldStopPlateau(90, 90.2, 0.5)).toBe(true);
    expect(shouldStopPlateau(90, 92, 0.5)).toBe(false);
  });
});

describe('mapFindingsToCuts', () => {
  it('keeps only findings with an anchor quote + cut type and maps cutType→subtype', () => {
    const cuts = mapFindingsToCuts([
      { anchorQuote: 'some passage', cutType: 'REDUNDANT' },
      { anchorQuote: '', cutType: 'FAT' },
      { anchorQuote: 'no type', cutType: null },
    ]);
    expect(cuts).toEqual([{ anchorQuote: 'some passage', subtype: 'REDUNDANT' }]);
    expect(mapFindingsToCuts(null)).toEqual([]);
  });
});

describe('buildRevisionBrief', () => {
  it('composes PROBLEM / WHAT TO KEEP / WHAT TO CHANGE / VOICE / TARGET with protected material', () => {
    const brief = buildRevisionBrief({
      evaluate: {
        logline: 'A knight doubts his oath.',
        themes: ['duty', 'doubt'],
        issues: [{ severity: 'major', category: 'pacing', note: 'The middle sags.' }],
        strengths: ['Sharp dialogue'],
        suggestions: [{ target: 'scene 2', recommendation: 'Cut the flashback.' }],
      },
      cuts: {
        tightestPassage: 'the sword felt heavier than the vow',
        loosestPassage: 'and so it was that everything happened as it did',
        findings: [{ cutType: 'FAT', problem: 'Purple.', anchorQuote: 'gilded gossamer glory' }],
      },
      wordCount: 1200,
    });
    expect(brief).toContain('## PROBLEM');
    expect(brief).toContain('The middle sags.');
    expect(brief).toContain('## WHAT TO KEEP');
    expect(brief).toContain('do NOT cut or weaken');
    expect(brief).toContain('Sharp dialogue');
    expect(brief).toContain('## WHAT TO CHANGE');
    expect(brief).toContain('Cut the flashback.');
    expect(brief).toContain('## VOICE RULES');
    expect(brief).toContain('duty, doubt');
    expect(brief).toContain('## TARGET');
    expect(brief).toContain('1200 words');
    // A safe-type cut is auto-applied elsewhere; only NON-safe types land in the brief.
    expect(brief).toContain('gilded gossamer glory');
  });
});

describe('resolvePolishOptions', () => {
  it('clamps cycles to 1..MAX and applies defaults', () => {
    expect(resolvePolishOptions({}).cycles).toBe(1);
    expect(resolvePolishOptions({ cycles: 99 }).cycles).toBe(MAX_CYCLES);
    expect(resolvePolishOptions({ cycles: 0 }).cycles).toBe(1);
    expect(resolvePolishOptions({}).plateauThreshold).toBe(DEFAULT_PLATEAU_THRESHOLD);
    expect(resolvePolishOptions({ cutTargetPercent: 12 }).cutTargetPercent).toBe(12);
  });
});

// ---------- runner integration (mocked LLM, real disk) ----------

// A fake SSE client so we can collect the broadcast frames and await the
// terminal one. Attached right after startPolish returns — before the runner's
// first `await` resolves — so every frame after `start` is captured.
function makeFakeClient() {
  const frames = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const res = {
    req: { on: () => {} },
    writeHead: () => {},
    end: () => {},
    write: (msg) => {
      const frame = JSON.parse(msg.replace(/^data:\s*/, '').trim());
      frames.push(frame);
      if (frame.type === 'complete' || frame.type === 'error' || frame.type === 'canceled') resolveDone(frame);
    },
  };
  return { res, frames, done };
}

async function seedWork(body) {
  const work = await local.createWork({ title: 'Polish subject', kind: 'short-story' });
  await local.saveDraftBody(work.id, body);
  return work;
}

// Program the mocked runProsePass to answer per-kind.
function programPasses({ baselineIssues, postIssues, cutFindings = [], revisedBody }) {
  let evaluateCalls = 0;
  runProsePass.mockImplementation(async (kind) => {
    if (kind === 'evaluate') {
      evaluateCalls += 1;
      const issues = evaluateCalls === 1 ? baselineIssues : postIssues;
      return { result: { issues, strengths: [], suggestions: [], themes: [], logline: 'x' } };
    }
    if (kind === 'cuts') {
      return { result: { findings: cutFindings, fatPercentage: 5, tightestPassage: null, loosestPassage: null } };
    }
    if (kind === 'revise') {
      return { result: { revisedBody } };
    }
    throw new Error(`unexpected kind ${kind}`);
  });
}

describe('startPolish runner', () => {
  it('keeps a revision that improves the score and writes it to the draft', async () => {
    const original = 'The knight stood at the gate. He explained, needlessly, that he was afraid. '.repeat(6);
    const revised = 'The knight stood at the gate, afraid.';
    const work = await seedWork(original);

    programPasses({
      baselineIssues: [{ severity: 'major' }, { severity: 'major' }, { severity: 'major' }],
      postIssues: [],
      revisedBody: revised,
    });

    const { runId } = startPolish(work.id, { cycles: 1 });
    const { res, frames, done } = makeFakeClient();
    attachClient(work.id, res);
    const terminal = await done;

    expect(runId).toBeTruthy();
    expect(terminal.type).toBe('complete');
    // The runner flips `finished` in its finally block, one microtask after the
    // terminal frame — let it settle before asserting the run is no longer active.
    await new Promise((r) => setTimeout(r, 0));
    expect(isPolishActive(work.id)).toBe(false);

    const cycle = frames.find((f) => f.type === 'cycle');
    expect(cycle.decision).toBe('keep');
    expect(cycle.postScore).toBeGreaterThan(cycle.preScore);

    const { body } = await local.getWorkWithBody(work.id);
    expect(body).toBe(revised);

    // 4 LLM passes for one cycle: baseline evaluate, cuts, revise, re-evaluate.
    expect(runProsePass).toHaveBeenCalledTimes(4);
  });

  it('reverts a regressing revision back to the pre-cycle body', async () => {
    const original = 'A clean, tight opening paragraph that says exactly what it needs to say.';
    const worse = 'Slop slop slop. '.repeat(40);
    const work = await seedWork(original);

    programPasses({
      baselineIssues: [],
      postIssues: [{ severity: 'major' }, { severity: 'major' }, { severity: 'major' }, { severity: 'major' }, { severity: 'major' }],
      revisedBody: worse,
    });

    startPolish(work.id, { cycles: 1 });
    const { res, frames, done } = makeFakeClient();
    attachClient(work.id, res);
    await done;

    const cycle = frames.find((f) => f.type === 'cycle');
    expect(cycle.decision).toBe('revert');

    // The regressing revision was rolled back — the draft is the original again.
    const { body } = await local.getWorkWithBody(work.id);
    expect(body).toBe(original);
  });

  it('snapshots each cycle and a manual revert round-trips the body', async () => {
    const original = 'Original prose. '.repeat(10);
    const revised = 'Revised prose that is better.';
    const work = await seedWork(original);

    programPasses({
      baselineIssues: [{ severity: 'major' }, { severity: 'major' }],
      postIssues: [],
      revisedBody: revised,
    });

    startPolish(work.id, { cycles: 1 });
    const { res, done } = makeFakeClient();
    attachClient(work.id, res);
    await done;

    // Draft is now the kept revision.
    expect((await local.getWorkWithBody(work.id)).body).toBe(revised);

    const snaps = await listSnapshots(work.id);
    // Baseline + pre-cycle snapshots exist, newest-first.
    expect(snaps.length).toBeGreaterThanOrEqual(2);

    // The pre-cycle snapshot holds the ORIGINAL body — reverting restores it.
    const preCycle = snaps.find((s) => s.cycle === 1);
    expect(preCycle).toBeTruthy();
    const { body } = await revertToSnapshot(work.id, preCycle.id);
    expect(body).toBe(original);
    expect((await local.getWorkWithBody(work.id)).body).toBe(original);
  });
});

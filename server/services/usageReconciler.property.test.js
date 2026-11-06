/**
 * Property tests for the transcript-attribution invariant that five rounds of
 * review kept circling: **across any number of runs reading the same transcript,
 * the tokens billed must sum to exactly what the transcript reported — never
 * more (double-billing), and no per-model bucket may disagree with its own
 * aggregate.**
 *
 * Every scenario-based bug found in review (overlapping windows, a rollout that
 * grew between reads, snapshots sharing an epoch millisecond, an early run
 * claiming later growth) was one instance of that invariant breaking. These tests
 * generate the shapes randomly instead of enumerating them, so a future change
 * that reintroduces the class gets caught even in a shape nobody wrote a case for.
 *
 * The PRNG is seeded, so a failure reproduces exactly.
 */
import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-usage-property-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
afterAll(cleanup);
vi.mock('./usage.js', () => ({
  markUsageRunReconciled: vi.fn(),
  recordRunUsage: vi.fn()
}));
const { readMeasuredUsage, __resetUsageClaims } = await import('./usageReconciler.js');

const WORKSPACE = '/work/example-repo';
const PROJECT_SLUG = '-work-example-repo';
const T0 = Date.parse('2026-07-01T10:00:00.000Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

// Seeded LCG — deterministic, so a reported failure is reproducible.
const makeRandom = (seed) => {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return Math.floor((state / 0x7fffffff) * n);
  };
};

describe('property: Codex rollout attribution', () => {
  it('two runs never bill more than the rollout reported, across 200 random shapes', async () => {
    const pick = makeRandom(12345);
    const violations = [];

    for (let trial = 0; trial < 200; trial++) {
      const home = await mkdtemp(join(tmpdir(), 'portos-prop-codex-'));
      __resetUsageClaims();
      const dir = join(home, '.codex', 'sessions', '2026', '07', '01');
      await mkdir(dir, { recursive: true });

      // Monotonically-increasing cumulative snapshots, as Codex writes them.
      const snapshots = [];
      let minute = 1 + pick(5);
      let cumulativeOut = 0;
      let cumulativeIn = 0;
      for (let i = 0, n = 1 + pick(4); i < n; i++) {
        cumulativeOut += 10 + pick(200);
        cumulativeIn += 100 + pick(1000);
        snapshots.push([iso(minute), cumulativeIn, 0, cumulativeOut]);
        minute += 1 + pick(8);
      }
      const reportedOut = cumulativeOut;

      const serialize = (snaps) => [
        JSON.stringify({ timestamp: iso(0), type: 'session_meta', payload: { id: 'rollout-1', cwd: WORKSPACE, model: 'gpt-5.3-codex' } }),
        ...snaps.map(([timestamp, input, cached, output]) => JSON.stringify({
          timestamp,
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } }
        }))
      ].join('\n');

      const window = () => {
        const start = pick(40);
        return [iso(start), iso(start + 1 + pick(20))];
      };
      const [w1, w2] = [window(), window()];
      // Sometimes the rollout only grows to its full length AFTER the first read.
      const growsBetween = pick(2) === 0;
      const prefix = 1 + pick(snapshots.length);

      const path = join(dir, 'rollout-1.jsonl');
      await writeFile(path, serialize(growsBetween ? snapshots.slice(0, prefix) : snapshots));
      const first = await readMeasuredUsage({ workspacePath: WORKSPACE, startTime: w1[0], endTime: w1[1], family: 'codex', home });
      if (growsBetween) await writeFile(path, serialize(snapshots));
      const second = await readMeasuredUsage({ workspacePath: WORKSPACE, startTime: w2[0], endTime: w2[1], family: 'codex', home });

      const billed = (first?.tokensOut || 0) + (second?.tokensOut || 0);
      if (billed > reportedOut) {
        violations.push({ trial, billed, reportedOut, w1, w2, growsBetween });
      }
      for (const result of [first, second]) {
        const bucket = result?.byModel?.['gpt-5.3-codex'];
        if (bucket && bucket.tokensOut !== result.tokensOut) {
          violations.push({ trial, kind: 'byModel disagrees with aggregate', bucket: bucket.tokensOut, aggregate: result.tokensOut });
        }
      }
      await rm(home, { recursive: true, force: true });
    }

    expect(violations).toEqual([]);
  }, 60_000);
});

describe('property: Claude claim ledger', () => {
  it('never bills a message twice across several concurrent runs, over 150 random shapes', async () => {
    const pick = makeRandom(999);
    const violations = [];

    for (let trial = 0; trial < 150; trial++) {
      const home = await mkdtemp(join(tmpdir(), 'portos-prop-claude-'));
      __resetUsageClaims();
      const dir = join(home, '.claude', 'projects', PROJECT_SLUG);
      await mkdir(dir, { recursive: true });

      let reportedOut = 0;
      for (let file = 0, files = 1 + pick(3); file < files; file++) {
        const lines = [];
        for (let i = 0, n = 1 + pick(4); i < n; i++) {
          const output = 10 + pick(100);
          reportedOut += output;
          // Vary WHICH identifiers the line carries. A line with neither
          // `message.id` nor `uuid` was invisible to the claim ledger and got
          // double-billed — a shape the first version of this generator could not
          // produce, so it is generated explicitly now.
          const identifiers = pick(4);
          const record = {
            type: 'assistant',
            cwd: WORKSPACE,
            timestamp: iso(pick(40)),
            message: {
              model: 'claude-opus-5',
              usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
            }
          };
          if (identifiers !== 1 && identifiers !== 3) record.message.id = `m${file}-${i}`;
          if (identifiers !== 2 && identifiers !== 3) record.uuid = `u${file}-${i}`;
          lines.push(JSON.stringify(record));
        }
        await writeFile(join(dir, `session-${file}.jsonl`), lines.join('\n'));
      }

      // Several runs reading CONCURRENTLY — the case a claim-at-the-end ledger got
      // wrong, since each read awaits once per file and they interleave.
      const reads = [];
      for (let r = 0, runs = 2 + pick(3); r < runs; r++) {
        const start = pick(40);
        reads.push(readMeasuredUsage({
          workspacePath: WORKSPACE, startTime: iso(start), endTime: iso(start + 1 + pick(25)), family: 'claude', home
        }));
      }
      const results = await Promise.all(reads);

      const billed = results.reduce((sum, r) => sum + (r?.tokensOut || 0), 0);
      if (billed > reportedOut) violations.push({ trial, billed, reportedOut });
      for (const result of results) {
        const bucket = result?.byModel?.['claude-opus-5'];
        if (bucket && bucket.tokensOut !== result.tokensOut) {
          violations.push({ trial, kind: 'byModel disagrees with aggregate' });
        }
      }
      await rm(home, { recursive: true, force: true });
    }

    expect(violations).toEqual([]);
  }, 60_000);
});

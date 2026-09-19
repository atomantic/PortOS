/**
 * The Python half of the trained-head contract.
 *
 * `jev_head_kit.py` is the code the SIDECAR runs, and every assertion below
 * pins something a Node-side test cannot reach: the head file a request
 * actually resolves to, the revision refusal at the point of load, and the
 * arithmetic that turns a head's layers into the checkpoint's three labels.
 * `server/lib/jevHead.test.js` asserts the same contract on the Node side —
 * both sides have to agree or a head is validated by one and misapplied by the
 * other.
 *
 * No torch: `validate_head`, `load_head` and `apply_head` need only `json` and
 * `math`, so this runs on a bare interpreter in CI.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const REVISION = 'pinned-revision';

const HARNESS = `
import json, runpy, sys
kit = runpy.run_path(sys.argv[1])
`;

const run = (body) => execFileSync(
  python,
  ['-c', HARNESS + body, join(scriptsDir, 'jev_head_kit.py')],
  { encoding: 'utf8', timeout: 20_000 },
);

/**
 * A head whose weights make the label mapping observable: each output row picks
 * a different input, so a permuted mapping would move the entailment score
 * rather than merely scaling it.
 */
const head = (overrides = {}) => ({
  schemaVersion: 1,
  decisionId: 'scope-adherence',
  architecture: 'linear',
  pooling: 'last-token',
  baseModel: { id: 'openjev-qwen3.5-4b-nli', repository: 'AlexWortega/openjev', revision: REVISION },
  hiddenSize: 3,
  labels: ['contradiction', 'entailment', 'neutral'],
  layers: [{ weight: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], bias: [0, 0, 0] }],
  metrics: { trained: 0.71, stockZeroShot: 0.58, majorityClass: 0.52, goldSize: 40, trainSize: 120 },
  corpusHash: 'deadbeefcafe0001',
  corpusSources: ['merged-pr'],
  trainedAt: '2026-09-19T00:00:00.000Z',
  ...overrides,
});

/** A heads directory holding `scope-adherence.json`, plus a file outside it. */
function headsDir(contents = head()) {
  const root = mkdtempSync(join(tmpdir(), 'portos-jev-kit-'));
  const dir = join(root, 'heads');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scope-adherence.json'), JSON.stringify(contents));
  // The file a path-traversal slug would reach if the charset check were absent.
  writeFileSync(join(root, 'escaped.json'), JSON.stringify(contents));
  return { root, dir };
}

describe.skipIf(!python)('jev trained-head kit', () => {
  it('applies a head and reports the checkpoint\'s three labels in its own order', () => {
    const raw = JSON.parse(run(`
scores = kit["apply_head"](json.loads(${JSON.stringify(JSON.stringify(head()))}), [0.0, 2.0, 0.0])
print(json.dumps({"labels": list(scores.keys()), "top": max(scores, key=scores.get), "sum": round(sum(scores.values()), 9)}))
`));
    // The second input dominates, and the second output row reads it — so the
    // winner is `entailment` only if the label mapping is positional and
    // correct. A permuted mapping moves the winner, not just the magnitude.
    expect(raw.labels).toEqual(['contradiction', 'entailment', 'neutral']);
    expect(raw.top).toBe('entailment');
    expect(raw.sum).toBe(1);
  });

  it('puts a ReLU between layers and none after the last', () => {
    const mlp = head({
      architecture: 'mlp1',
      layers: [
        // The negative row is clamped to zero by the hidden ReLU; without it the
        // -5 would flow through and flip the winner.
        { weight: [[1, 0, 0], [-5, 0, 0]], bias: [0, 0] },
        { weight: [[0, 1], [1, 0], [0, 1]], bias: [0, 0, 0] },
      ],
    });
    const raw = JSON.parse(run(`
scores = kit["apply_head"](json.loads(${JSON.stringify(JSON.stringify(mlp))}), [2.0, 0.0, 0.0])
print(json.dumps({"top": max(scores, key=scores.get)}))
`));
    expect(raw).toEqual({ top: 'entailment' });
  });

  it('refuses a head fit on a different encoder revision', () => {
    const { dir } = headsDir(head({
      baseModel: { id: 'openjev-qwen3.5-4b-nli', repository: 'AlexWortega/openjev', revision: 'other' },
    }));
    expect(loadCode(dir, 'scope-adherence')).toBe('jev-head-revision-mismatch');
  });

  // A head is addressed by SLUG and resolved inside a directory the Node
  // service owns. This is what keeps a slug from becoming a path.
  it('refuses a slug that would escape the heads directory', () => {
    const { dir } = headsDir();
    expect(loadCode(dir, '../escaped')).toBe('jev-head-invalid');
    expect(loadCode(dir, 'sub/scope-adherence')).toBe('jev-head-invalid');
    expect(loadCode(dir, 'Scope-Adherence')).toBe('jev-head-invalid');
    // Non-vacuity: the same loader accepts the legitimate slug in that dir.
    expect(loadCode(dir, 'scope-adherence')).toBeNull();
  });

  it('reports a missing head rather than an unreadable one', () => {
    const { dir } = headsDir();
    expect(loadCode(dir, 'message-triage')).toBe('jev-head-not-found');
  });

  it('reports an unparseable head file as unreadable', () => {
    const { dir } = headsDir();
    writeFileSync(join(dir, 'message-triage.json'), 'not json');
    expect(loadCode(dir, 'message-triage')).toBe('jev-head-unreadable');
  });

  // The sidecar outlives adopt and discard, and Node's `resetJevHeadCache`
  // cannot reach it — so the file's identity is what makes its cache
  // invalidatable from the side that can observe an adoption.
  it('moves a head file\'s identity when its contents are replaced', () => {
    const { dir } = headsDir();
    const first = identity(dir, 'scope-adherence');
    expect(first).not.toBeNull();
    // A different LENGTH as well as different bytes: a same-size rewrite in the
    // same clock tick would leave the fingerprint unchanged on a filesystem
    // with coarse mtime resolution, and this test is not the place to find out.
    writeFileSync(join(dir, 'scope-adherence.json'), JSON.stringify(head({
      corpusHash: 'cafe000000000002',
      corpusSources: ['merged-pr', 'closed-unmerged-pr', 'parked-issue'],
    })));
    expect(identity(dir, 'scope-adherence')).not.toEqual(first);
    // No file is an absence, not a fingerprint that could collide with one.
    expect(identity(dir, 'message-triage')).toBeNull();
  });

  it('rejects the shapes the Node-side parser rejects', () => {
    const cases = {
      relabelled: head({ labels: ['entailment', 'contradiction', 'neutral'] }),
      // The two rules the Node parser enforces that this mirror once did not:
      // a `linear` head declaring two layers, and an `mlp1` declaring one.
      linearWithTwoLayers: head({
        layers: [
          { weight: [[1, 0, 0], [0, 1, 0]], bias: [0, 0] },
          { weight: [[1, 0], [0, 1], [1, 1]], bias: [0, 0, 0] },
        ],
      }),
      mlpWithOneLayer: head({ architecture: 'mlp1' }),
      wrongHiddenSize: head({ hiddenSize: 8 }),
      wrongOutputWidth: head({ layers: [{ weight: [[1, 0, 0], [0, 1, 0]], bias: [0, 0] }] }),
      biasMismatch: head({ layers: [{ weight: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], bias: [0, 0] }] }),
      unknownPooling: head({ pooling: 'mean' }),
      futureSchema: head({ schemaVersion: 2 }),
      nonFiniteWeight: head({ layers: [{ weight: [[1, 0, 0], [0, 1, 0], [0, 0, 'x']], bias: [0, 0, 0] }] }),
    };
    const raw = JSON.parse(run(`
cases = json.loads(${JSON.stringify(JSON.stringify(cases))})
out = {}
for name, value in cases.items():
    try:
        kit["validate_head"](value, revision=${JSON.stringify(REVISION)})
        out[name] = None
    except kit["HeadError"] as error:
        out[name] = error.code
print(json.dumps(out))
`));
    expect(raw).toEqual({
      relabelled: 'jev-head-invalid',
      linearWithTwoLayers: 'jev-head-invalid',
      mlpWithOneLayer: 'jev-head-invalid',
      wrongHiddenSize: 'jev-head-invalid',
      wrongOutputWidth: 'jev-head-invalid',
      biasMismatch: 'jev-head-invalid',
      unknownPooling: 'jev-head-invalid',
      futureSchema: 'jev-head-invalid',
      nonFiniteWeight: 'jev-head-invalid',
    });
  });
});

/** `head_file_identity` for one slug, as a comparable value. */
function identity(dir, slug) {
  return JSON.parse(run(`
value = kit["head_file_identity"](${JSON.stringify(dir)}, ${JSON.stringify(slug)})
print(json.dumps({"identity": list(value) if value else None}))
`)).identity;
}

/** `load_head`'s failure code for one slug, or null when it loaded. */
function loadCode(dir, slug) {
  return JSON.parse(run(`
try:
    kit["load_head"](${JSON.stringify(dir)}, ${JSON.stringify(slug)}, revision=${JSON.stringify(REVISION)})
    print(json.dumps({"code": None}))
except kit["HeadError"] as error:
    print(json.dumps({"code": error.code}))
`)).code;
}

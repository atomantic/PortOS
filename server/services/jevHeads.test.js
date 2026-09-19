/**
 * The trained-head store, and the one thing it exists to enforce.
 *
 * ADOPTION IS GATED SERVER-SIDE. A UI that merely hides the button is a
 * suggestion, and the number it would hide the button over came from this
 * machine's own private history — so the refusal is asserted here, on the
 * function every surface has to go through, not on a rendered disabled state.
 */

import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JEV_LABELS } from '../lib/jev.js';
import { JEV_HEAD_POOLING, JEV_HEAD_SCHEMA_VERSION } from '../lib/jevHead.js';

const dataRoot = await mkdtemp(join(tmpdir(), 'portos-jev-heads-'));
vi.mock('../lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: dataRoot } };
});

const {
  adoptJevHead, describeJevHeads, discardJevHead, getAdoptedJevHead,
  jevHeadsDir, resetJevHeadCache, saveCandidateJevHead,
} = await import('./jevHeads.js');
const { JEV_MODEL } = await import('../lib/jev.js');

const head = (overrides = {}) => ({
  schemaVersion: JEV_HEAD_SCHEMA_VERSION,
  decisionId: 'scope-adherence',
  architecture: 'linear',
  pooling: JEV_HEAD_POOLING,
  baseModel: { id: JEV_MODEL.id, repository: JEV_MODEL.repository, revision: JEV_MODEL.revision },
  hiddenSize: 2,
  labels: [...JEV_LABELS],
  layers: [{ weight: [[1, 0], [0, 1], [1, 1]], bias: [0, 0, 0] }],
  metrics: { trained: 0.71, stockZeroShot: 0.58, majorityClass: 0.52, goldSize: 40, trainSize: 120 },
  corpusHash: 'deadbeefcafe0001',
  corpusSources: ['merged-pr'],
  trainedAt: '2026-09-19T00:00:00.000Z',
  ...overrides,
});

beforeEach(async () => {
  await mkdir(jevHeadsDir(), { recursive: true });
  resetJevHeadCache();
});

afterEach(async () => {
  const { rm } = await import('fs/promises');
  await rm(jevHeadsDir(), { recursive: true, force: true });
  resetJevHeadCache();
});

describe('saveCandidateJevHead', () => {
  // Training NEVER adopts. A run that promoted its own output would make the
  // three measured numbers decoration.
  it('writes a candidate and leaves nothing adopted', async () => {
    expect((await saveCandidateJevHead('scope-adherence', head())).ok).toBe(true);
    expect(await getAdoptedJevHead('scope-adherence')).toBeNull();
    const described = await describeJevHeads();
    expect(described.heads).toHaveLength(1);
    expect(described.heads[0]).toMatchObject({ decisionId: 'scope-adherence', adopted: false, beatsBaselines: true });
  });

  it('refuses a head fit on a different encoder revision', async () => {
    const result = await saveCandidateJevHead('scope-adherence', head({
      baseModel: { id: JEV_MODEL.id, repository: JEV_MODEL.repository, revision: 'some-other-revision' },
    }));
    expect(result).toEqual({ ok: false, code: 'jev-head-revision-mismatch' });
  });

  it('refuses a head whose declared decision is not the one being saved', async () => {
    const result = await saveCandidateJevHead('scope-adherence', head({ decisionId: 'message-triage' }));
    expect(result).toEqual({ ok: false, code: 'jev-head-invalid' });
  });
});

describe('adoptJevHead — the gate', () => {
  it('promotes a candidate that beats both baselines, and consumes it', async () => {
    await saveCandidateJevHead('scope-adherence', head());
    expect((await adoptJevHead('scope-adherence')).ok).toBe(true);
    expect(await getAdoptedJevHead('scope-adherence')).toMatchObject({ corpusHash: 'deadbeefcafe0001' });
    // The candidate is gone, so the panel cannot show one artifact twice in two
    // states with no way to tell which is answering.
    const described = await describeJevHeads();
    expect(described.heads.map((row) => row.adopted)).toEqual([true]);
  });

  it('refuses a head that does not beat the stock zero-shot classifier', async () => {
    await saveCandidateJevHead('scope-adherence', head({
      metrics: { trained: 0.55, stockZeroShot: 0.62, majorityClass: 0.40, goldSize: 40, trainSize: 120 },
    }));
    expect(await adoptJevHead('scope-adherence')).toEqual({ ok: false, code: 'jev-head-below-zero-shot' });
    expect(await getAdoptedJevHead('scope-adherence')).toBeNull();
  });

  it('refuses a head that does not beat the majority class', async () => {
    await saveCandidateJevHead('scope-adherence', head({
      metrics: { trained: 0.74, stockZeroShot: 0.61, majorityClass: 0.80, goldSize: 40, trainSize: 120 },
    }));
    expect(await adoptJevHead('scope-adherence')).toEqual({ ok: false, code: 'jev-head-below-majority-class' });
  });

  // Bypass probe: the refusals above must be the GATE firing, not the store
  // failing to find anything. Same candidate, one metric moved.
  it('the same artifact adopts once its trained score clears both baselines', async () => {
    await saveCandidateJevHead('scope-adherence', head({
      metrics: { trained: 0.55, stockZeroShot: 0.62, majorityClass: 0.40, goldSize: 40, trainSize: 120 },
    }));
    expect((await adoptJevHead('scope-adherence')).ok).toBe(false);
    await saveCandidateJevHead('scope-adherence', head({
      metrics: { trained: 0.71, stockZeroShot: 0.62, majorityClass: 0.40, goldSize: 40, trainSize: 120 },
    }));
    expect((await adoptJevHead('scope-adherence')).ok).toBe(true);
  });

  it('reports a missing candidate rather than adopting nothing', async () => {
    expect(await adoptJevHead('scope-adherence')).toEqual({ ok: false, code: 'jev-head-not-found' });
  });
});

describe('getAdoptedJevHead', () => {
  // Every reason a head might not apply falls back to the stock classifier —
  // which is what the install did before heads existed, and is always correct.
  it('falls back to null when the adopted head was fit on a stale revision', async () => {
    await mkdir(jevHeadsDir(), { recursive: true });
    await writeFile(join(jevHeadsDir(), 'scope-adherence.json'), JSON.stringify(head({
      baseModel: { id: JEV_MODEL.id, repository: JEV_MODEL.repository, revision: 'stale' },
    })));
    expect(await getAdoptedJevHead('scope-adherence')).toBeNull();
    // ...and says so, rather than reading as "no head trained".
    const described = await describeJevHeads();
    expect(described.heads[0]).toMatchObject({ adopted: true, compatible: false, baseRevision: 'stale' });
  });

  it('falls back to null on a corrupt file', async () => {
    await writeFile(join(jevHeadsDir(), 'scope-adherence.json'), 'not json');
    expect(await getAdoptedJevHead('scope-adherence')).toBeNull();
    expect((await describeJevHeads()).heads[0]).toMatchObject({ ok: false, code: 'jev-head-unreadable' });
  });

  it('returns null for a decision id that is not in the registry', async () => {
    expect(await getAdoptedJevHead('not-a-decision')).toBeNull();
  });
});

describe('discardJevHead', () => {
  it('returns an adopted decision to the stock classifier', async () => {
    await saveCandidateJevHead('scope-adherence', head());
    await adoptJevHead('scope-adherence');
    expect(await discardJevHead('scope-adherence', { candidate: false })).toEqual({ ok: true, removed: true });
    expect(await getAdoptedJevHead('scope-adherence')).toBeNull();
  });

  it('is idempotent when there is nothing to discard', async () => {
    expect(await discardJevHead('scope-adherence')).toEqual({ ok: true, removed: false });
  });
});

describe('on-disk layout', () => {
  // The backup tiers in `services/backup.js` are anchored to these exact
  // directory names; a rename here silently changes what is snapshotted.
  it('keeps heads, corpora and embeddings under data/jev/', async () => {
    const { jevCorporaDir, jevDataDir, jevEmbeddingsDir } = await import('./jevHeads.js');
    expect(jevDataDir()).toBe(join(dataRoot, 'jev'));
    expect(jevHeadsDir()).toBe(join(dataRoot, 'jev', 'heads'));
    expect(jevCorporaDir()).toBe(join(dataRoot, 'jev', 'corpora'));
    expect(jevEmbeddingsDir()).toBe(join(dataRoot, 'jev', 'embeddings'));
  });

  // The slug the sidecar resolves is the decision id, so an adopted head has
  // to land at exactly `<decisionId>.json`.
  it('names an adopted head after its decision id', async () => {
    await saveCandidateJevHead('scope-adherence', head());
    await adoptJevHead('scope-adherence');
    const written = JSON.parse(await readFile(join(jevHeadsDir(), 'scope-adherence.json'), 'utf8'));
    expect(written.decisionId).toBe('scope-adherence');
  });
});

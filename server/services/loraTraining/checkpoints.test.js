import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { deflateRawSync } from 'zlib';
import sharp from 'sharp';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let dataRoot = tmpdir();

// Point PATHS.trainingRuns/loras at a per-suite temp root so the
// filesystem-touching helpers (preview analysis, zip extraction) operate on
// fixtures instead of real run data.
vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: () => dataRoot,
    extraOverrides: (root) => ({
      trainingRuns: join(root, 'training-runs'),
      loras: join(root, 'loras'),
    }),
  }));

const {
  listRunCheckpoints,
  listRunSamples,
  isPreviewCollapsed,
  resolveCheckpointAdapterBuffer,
  selectDeployableCheckpoint,
  COLLAPSE_ENTROPY_MAX,
} = await import('./checkpoints.js');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;

function zipEntry(name, payload, method) {
  const nameBuf = Buffer.from(name, 'utf-8');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(LOCAL_SIG, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(method, 8);
  h.writeUInt32LE(payload.length, 18);
  h.writeUInt32LE(payload.length, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([h, nameBuf, payload]);
}
function eocd() { const b = Buffer.alloc(4); b.writeUInt32LE(CENTRAL_SIG, 0); return b; }

/** A checkpoint zip: optimizer (stored) then the deflated adapter. */
function checkpointZip(step, adapterBytes) {
  const pad = String(step).padStart(7, '0');
  return Buffer.concat([
    zipEntry(`${pad}_optimizer.safetensors`, Buffer.alloc(256, 9), 0),
    zipEntry(`${pad}_adapter.safetensors`, deflateRawSync(adapterBytes), 8),
    eocd(),
  ]);
}

// A high-variance gradient PNG (entropy well above the collapse floor).
const noisyPng = () => {
  const w = 64; const h = 64; const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 73) % 256;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
};
// A flat black PNG — the degenerate-collapse case.
const blackPng = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();

const RUN_ID = 'run-fixture';
const ADAPTER_250 = Buffer.from('ADAPTER-AT-STEP-250');
const ADAPTER_500 = Buffer.from('ADAPTER-AT-STEP-500');

function buildRun(overrides = {}) {
  return {
    id: RUN_ID,
    runtime: 'mflux',
    progress: { step: 500 },
    output: { selectedCheckpointStep: 250, loraFilename: 'lora-x.safetensors' },
    artifacts: {
      checkpoints: [
        { step: 250, path: '0000250_checkpoint.zip', loss: 0.64 },
        { step: 500, path: '0000500_checkpoint.zip', loss: 0.53 },
      ],
      samples: [
        '0000250_preview_image_preview_1.png',
        '0000500_preview_image_preview_1.png',
      ],
    },
    ...overrides,
  };
}

describe('loraTraining/checkpoints', () => {
  let runDir;
  let finalAdapterPath;

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'ckpt-test-'));
    runDir = join(dataRoot, 'training-runs', RUN_ID);
    mkdirSync(join(runDir, 'mflux', 'checkpoints'), { recursive: true });
    mkdirSync(join(runDir, 'samples'), { recursive: true });
    await writeFile(join(runDir, 'mflux', 'checkpoints', '0000250_checkpoint.zip'), checkpointZip(250, ADAPTER_250));
    await writeFile(join(runDir, 'mflux', 'checkpoints', '0000500_checkpoint.zip'), checkpointZip(500, ADAPTER_500));
    await writeFile(join(runDir, 'samples', '0000250_preview_image_preview_1.png'), await noisyPng());
    await writeFile(join(runDir, 'samples', '0000500_preview_image_preview_1.png'), await blackPng());
    // Stand-in for the wrapper-extracted final adapter on disk (step 500).
    finalAdapterPath = join(runDir, 'adapter.safetensors');
    await writeFile(finalAdapterPath, ADAPTER_500);
  });

  afterAll(() => { rmSync(dataRoot, { recursive: true, force: true }); });

  it('lists checkpoints with loss, preview, and deployed flag (sorted by step)', () => {
    const list = listRunCheckpoints(buildRun());
    expect(list.map((c) => c.step)).toEqual([250, 500]);
    expect(list[0]).toMatchObject({ step: 250, loss: 0.64, hasPreview: true, deployed: true });
    expect(list[0].previewUrl).toContain('0000250_preview');
    expect(list[1].deployed).toBe(false);
  });

  it('lists samples as step+url sorted by step (seeds the live gallery)', () => {
    const samples = listRunSamples(buildRun());
    expect(samples.map((s) => s.step)).toEqual([250, 500]);
    expect(samples[0].url).toContain(`/runs/${RUN_ID}/samples/0000250_preview`);
    // flux2 naming + unparseable names: keep the parseable ones, sorted.
    const mixed = listRunSamples(buildRun({
      artifacts: { checkpoints: [], samples: ['step-000500.png', 'garbage.png', 'step-000250.png'] },
    }));
    expect(mixed.map((s) => s.step)).toEqual([250, 500]);
  });

  it('returns no samples when the run has none recorded', () => {
    expect(listRunSamples(buildRun({ artifacts: { checkpoints: [], samples: [] } }))).toEqual([]);
    expect(listRunSamples({ id: RUN_ID })).toEqual([]);
  });

  it('joins preview by the filename-derived step even when the recorded step drifted', async () => {
    // mflux tags the CHECKPOINT line with the poll-time tqdm step, which can
    // lag the save boundary — here the record says 252/502 but the zip names
    // (and previews) are at 250/500. The join must use the filename step.
    const run = buildRun({
      artifacts: {
        checkpoints: [
          { step: 252, path: '0000250_checkpoint.zip', loss: 0.64 },
          { step: 502, path: '0000500_checkpoint.zip', loss: 0.53 },
        ],
        samples: [
          '0000250_preview_image_preview_1.png',
          '0000500_preview_image_preview_1.png',
        ],
      },
      output: { selectedCheckpointStep: 250, loraFilename: 'lora-x.safetensors' },
    });
    const list = listRunCheckpoints(run);
    expect(list.map((c) => c.step)).toEqual([250, 500]); // canonical, not 252/502
    expect(list.every((c) => c.hasPreview)).toBe(true);
    expect(list[0].deployed).toBe(true); // selectedCheckpointStep 250 matches
    // And the adapter resolves by that canonical step despite the drifted record.
    expect((await resolveCheckpointAdapterBuffer(run, 250)).toString()).toBe(ADAPTER_250.toString());
  });

  it('flags a black preview as collapsed and a noisy one as healthy', async () => {
    expect(await isPreviewCollapsed(join(runDir, 'samples', '0000500_preview_image_preview_1.png'))).toBe(true);
    expect(await isPreviewCollapsed(join(runDir, 'samples', '0000250_preview_image_preview_1.png'))).toBe(false);
    // Analysis failure (missing file) must not falsely veto.
    expect(await isPreviewCollapsed(join(runDir, 'samples', 'nope.png'))).toBe(false);
    expect(COLLAPSE_ENTROPY_MAX).toBeGreaterThan(0);
  });

  it('cracks the right adapter out of a checkpoint zip', async () => {
    expect((await resolveCheckpointAdapterBuffer(buildRun(), 250)).toString()).toBe(ADAPTER_250.toString());
    expect((await resolveCheckpointAdapterBuffer(buildRun(), 500)).toString()).toBe(ADAPTER_500.toString());
  });

  it('throws for a step with no checkpoint artifact', async () => {
    await expect(resolveCheckpointAdapterBuffer(buildRun(), 999)).rejects.toThrow(/checkpoint zip missing/);
  });

  it('guard: falls back to the latest healthy checkpoint when the final preview collapsed', async () => {
    const sel = await selectDeployableCheckpoint(buildRun(), finalAdapterPath, 500);
    expect(sel.autoSelected).toBe(true);
    expect(sel.step).toBe(250);
    expect(sel.buffer.toString()).toBe(ADAPTER_250.toString());
    expect(sel.reason).toMatch(/collapsed/);
  });

  it('guard: keeps the final adapter when its preview is healthy', async () => {
    // finalStep 250 has the noisy (healthy) preview → no override.
    const sel = await selectDeployableCheckpoint(buildRun(), finalAdapterPath, 250);
    expect(sel.autoSelected).toBe(false);
    expect(sel.step).toBe(250);
    expect(sel.buffer.toString()).toBe(ADAPTER_500.toString()); // returns the on-disk final adapter as-is
  });

  it('guard: for flux2 keeps the separate final-step adapter even though it is not a recorded checkpoint', async () => {
    // flux2 writes the final adapter at finalStep separately (not as a
    // checkpoint), and renders a sample there. finalStep 500 is past the only
    // recorded checkpoint (250); its preview (black) collapses → falls back.
    const sel = await selectDeployableCheckpoint(buildRun(), finalAdapterPath, 500);
    expect(sel.autoSelected).toBe(true);
    expect(sel.step).toBe(250); // latest healthy checkpoint
  });

  it('guard: trusts the final adapter when there are no previews to judge', async () => {
    const run = buildRun({ artifacts: { checkpoints: [{ step: 500, path: '0000500_checkpoint.zip', loss: 0.5 }], samples: [] } });
    const sel = await selectDeployableCheckpoint(run, finalAdapterPath, 500);
    expect(sel.autoSelected).toBe(false);
    expect(sel.step).toBe(500);
  });
});

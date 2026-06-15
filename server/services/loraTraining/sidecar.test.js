import { describe, it, expect } from 'vitest';
import { buildTrainedSidecar, trainedLoraFilename } from './sidecar.js';

const baseRun = {
  id: '3f9a21c0-aaaa-bbbb-cccc-dddddddddddd',
  runtime: 'mflux',
  baseModelId: 'flux2-klein-4b',
  fluxVariant: '4b',
  name: null,
  character: { entryId: 'char-1', ingredientId: 'ing-1', universeId: 'uni-1', name: 'Kessa Brightwater' },
  datasetId: 'ds-1',
  triggerWord: 'kessa_brightwater',
  params: { steps: 1000, rank: 16, learningRate: 0.0001, resolution: 512, seed: 42 },
};

describe('trainedLoraFilename', () => {
  it('slugs the name with a runId suffix', () => {
    const filename = trainedLoraFilename({ name: null, characterName: 'Kessa Brightwater', runId: baseRun.id });
    expect(filename).toBe('lora-trained-kessa-brightwater-3f9a21c0.safetensors');
  });
});

describe('buildTrainedSidecar', () => {
  it('carries every field listLoras reads, plus training lineage', () => {
    const sidecar = buildTrainedSidecar({
      run: baseRun,
      result: { adapter_path: '/x/a.safetensors', steps: 1000, final_loss: 0.0812 },
      filename: 'lora-trained-kessa-3f9a21c0.safetensors',
      previewImageUrl: '/api/lora-training/runs/r/samples/step-001000.png',
      sizeBytes: 50 * 1024 * 1024,
    });
    // Fields the existing listLoras mapEntry consumes:
    expect(sidecar.name).toBe('Kessa Brightwater (trained)');
    expect(sidecar.civitai).toBeNull();
    // Both engines train FLUX.2 adapters — family is always flux2, gated
    // by size variant.
    expect(sidecar.runnerFamily).toBe('flux2');
    expect(sidecar.fluxVariant).toBe('4b');
    expect(sidecar.triggerWords).toEqual(['kessa_brightwater']);
    expect(sidecar.recommendedScale).toBe(1.0);
    expect(sidecar.installedAt).toBeTruthy();
    // Trained-LoRA additions:
    expect(sidecar.source).toBe('trained');
    expect(sidecar.character.entryId).toBe('char-1');
    expect(sidecar.character.ingredientId).toBe('ing-1');
    expect(sidecar.datasetId).toBe('ds-1');
    expect(sidecar.training.finalLoss).toBe(0.0812);
    expect(sidecar.file.sizeKB).toBe(51200);
  });

  it('records the deployed checkpoint and notes it when it differs from the final step', () => {
    const sidecar = buildTrainedSidecar({
      run: baseRun,
      result: { steps: 1008, final_loss: 0.05 },
      filename: 'x.safetensors',
      selectedStep: 250,
      autoSelected: true,
    });
    expect(sidecar.training.trainedSteps).toBe(1008);
    expect(sidecar.training.selectedCheckpointStep).toBe(250);
    expect(sidecar.training.autoSelectedCheckpoint).toBe(true);
    expect(sidecar.description).toContain('checkpoint @ step 250');
    expect(sidecar.description).toContain('auto-selected');
  });

  it('omits the checkpoint note when the final step was deployed', () => {
    const sidecar = buildTrainedSidecar({
      run: baseRun,
      result: { steps: 1008 },
      filename: 'x.safetensors',
      selectedStep: 1008,
    });
    expect(sidecar.training.selectedCheckpointStep).toBe(1008);
    expect(sidecar.training.autoSelectedCheckpoint).toBe(false);
    expect(sidecar.description).not.toContain('checkpoint @ step');
  });

  it('defaults the deployed checkpoint to the final step when unspecified', () => {
    const sidecar = buildTrainedSidecar({
      run: baseRun,
      result: { steps: 1008 },
      filename: 'x.safetensors',
    });
    expect(sidecar.training.selectedCheckpointStep).toBe(1008);
  });

  it('stamps the size variant for the torch runtime too', () => {
    const sidecar = buildTrainedSidecar({
      run: { ...baseRun, runtime: 'flux2', baseModelId: 'flux2-klein-9b-bf16', fluxVariant: '9b' },
      filename: 'x.safetensors',
    });
    expect(sidecar.runnerFamily).toBe('flux2');
    expect(sidecar.fluxVariant).toBe('9b');
  });
});

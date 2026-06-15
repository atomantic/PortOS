import { describe, it, expect, vi } from 'vitest';
import { makeTrainingLineHandler } from './progress.js';

const setup = (overrides = {}) => {
  const emit = vi.fn();
  const onCheckpoint = vi.fn();
  const onSample = vi.fn();
  const handler = makeTrainingLineHandler({
    jobId: 'job-1',
    totalSteps: 1000,
    emit,
    onCheckpoint,
    onSample,
    sampleUrl: (p) => `/api/lora-training/runs/r1/samples/${p.split('/').pop()}`,
    ...overrides,
  });
  return { ...handler, emit, onCheckpoint, onSample };
};

describe('makeTrainingLineHandler', () => {
  it('parses STEP lines into progress events with loss', () => {
    const { handleLine, emit } = setup();
    handleLine('STEP:250:1000:0.0812');
    const progress = emit.mock.calls.find(([e]) => e === 'progress')[1];
    expect(progress.progress).toBeCloseTo(0.25);
    expect(progress.step).toBe(250);
    expect(progress.totalSteps).toBe(1000);
    expect(progress.loss).toBeCloseTo(0.0812);
    expect(progress.message).toContain('250/1000');
    expect(progress.message).toContain('0.0812');
  });

  it('handles nan loss without a loss suffix (loss null)', () => {
    const { handleLine, emit } = setup();
    handleLine('STEP:5:100:nan');
    const progress = emit.mock.calls.find(([e]) => e === 'progress')[1];
    expect(progress.message).toBe('Training step 5/100');
    expect(progress.loss).toBeNull();
  });

  it('routes CHECKPOINT and SAMPLE lines to callbacks', () => {
    const { handleLine, emit, onCheckpoint, onSample } = setup();
    // A preceding STEP line sets lastLoss, which CHECKPOINT forwards so the
    // run record can show a per-checkpoint loss in the picker.
    handleLine('STEP:250:1000:0.42');
    handleLine('CHECKPOINT:/runs/r1/checkpoints/step-000250:250');
    expect(onCheckpoint).toHaveBeenCalledWith('/runs/r1/checkpoints/step-000250', 250, 0.42);
    handleLine('SAMPLE:/runs/r1/samples/step-000250.png:250');
    expect(onSample).toHaveBeenCalled();
    const preview = emit.mock.calls.find(([e, p]) => e === 'progress' && p.currentImage)[1];
    expect(preview.currentImage).toBe('/api/lora-training/runs/r1/samples/step-000250.png');
    expect(preview.step).toBe(250); // keys the live gallery thumbnail by step
    expect(preview.progress).toBeUndefined(); // preview frame, not a progress update
  });

  it('emits stage transitions once and swallows heartbeats', () => {
    const { handleLine, emit } = setup();
    handleLine('STAGE:training');
    handleLine('STAGE:training:heartbeat:20s');
    handleLine('STAGE:training');
    const stageEvents = emit.mock.calls.filter(([e, p]) => e === 'status' && p.message?.startsWith('Stage:'));
    expect(stageEvents).toHaveLength(1);
  });

  it('captures USER_ERROR and RESULT into state', () => {
    const { handleLine, getState } = setup();
    handleLine('USER_ERROR:DATASET_ERROR:caption file missing', 'stderr');
    handleLine('RESULT:{"adapter_path":"/r/adapter/x.safetensors","steps":1000,"final_loss":0.08}');
    const state = getState();
    expect(state.userError).toEqual({ kind: 'DATASET_ERROR', message: 'caption file missing' });
    expect(state.result.adapter_path).toBe('/r/adapter/x.safetensors');
  });

  it('keeps a bounded stderr tail and suppresses python noise', () => {
    const { handleLine, getState, emit } = setup();
    for (let i = 0; i < 60; i += 1) handleLine(`error line ${i}`, 'stderr');
    expect(getState().stderrTail).toHaveLength(50);
    emit.mockClear();
    handleLine('FutureWarning: torch.distributed deprecated thing', 'stderr');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits activity for every non-noise line', () => {
    const { handleLine, emit } = setup();
    handleLine('some unstructured trainer output');
    expect(emit.mock.calls.filter(([e]) => e === 'activity')).toHaveLength(1);
  });
});

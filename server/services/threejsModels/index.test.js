import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/fileUtils.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/mock/data' },
  resolveGalleryImage: vi.fn((filename) => (
    filename === 'missing.png' ? null : `/mock/data/images/${filename}`
  )),
}));

vi.mock('../promptRunner.js', () => ({
  runPromptThroughProvider: vi.fn(),
}));

vi.mock('../providers.js', () => ({
  getProviderById: vi.fn(),
}));

vi.mock('./db.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  mutateModel: vi.fn(),
  deleteModel: vi.fn(),
  recoverInterruptedModels: vi.fn(),
}));

import { runPromptThroughProvider } from '../promptRunner.js';
import { getProviderById } from '../providers.js';
import * as store from './db.js';
import { createModel, startGeneration } from './index.js';

const spec = {
  schemaVersion: 1,
  name: 'Example Beacon',
  summary: 'A compact beacon with a separate glowing lens.',
  subjectType: 'object',
  background: '#111827',
  camera: { position: [3, 2, 4] },
  materials: {
    body: { color: '#334155' },
    lens: { color: '#38bdf8', emissive: '#38bdf8', emissiveIntensity: 2 },
  },
  lights: [{ type: 'directional', intensity: 2 }],
  parts: [{
    id: 'body',
    name: 'Body',
    geometry: { type: 'cylinder', radiusTop: 0.5, radiusBottom: 0.7, height: 1.5 },
    material: 'body',
    children: [{
      id: 'lens',
      name: 'Lens',
      geometry: { type: 'sphere', radius: 0.35 },
      material: 'lens',
    }],
  }],
  detailInventory: [{
    feature: 'Glowing lens',
    evidence: 'A bright cyan lens caps the reference object.',
    implementationPartIds: ['lens'],
    priority: 'identity',
  }],
};

describe('Three.js model generation orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderById.mockResolvedValue({
      id: 'vision-api',
      name: 'Vision API',
      type: 'api',
      enabled: true,
      defaultModel: 'vision-default',
    });
  });

  it('rejects a source that is no longer in the MediaGen gallery', async () => {
    await expect(createModel({
      name: 'Missing',
      filename: 'missing.png',
      providerId: 'vision-api',
    })).rejects.toMatchObject({ status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
    expect(store.createModel).not.toHaveBeenCalled();
  });

  it('rejects a duplicate request while the model is generating', async () => {
    store.getModel.mockResolvedValue({
      id: 'threejs-busy',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      status: 'generating',
      generationOperationId: 'active-operation',
    });

    await expect(startGeneration('threejs-busy', {
      providerId: 'vision-api',
    })).rejects.toMatchObject({ status: 409, code: 'MODEL_BUSY' });
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('attaches the image for API providers and persists validated output', async () => {
    let current = {
      id: 'threejs-example',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      runs: [],
    };
    store.getModel.mockResolvedValue(current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(spec),
      runId: 'run-example',
      provider: { id: 'vision-api' },
      model: 'vision-pro',
    });

    const started = await startGeneration(current.id, {
      providerId: 'vision-api',
      model: 'vision-pro',
      prompt: 'Preserve the glowing lens.',
    });

    expect(started.status).toBe('generating');
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/mock/data',
      model: 'vision-pro',
      screenshots: ['/mock/data/images/example.png'],
      source: 'threejs-model-generation',
    }));
    expect(current.spec.name).toBe('Example Beacon');
    // The body mesh is claimed by no detail entry, so the assembly gate records
    // it alongside the spec instead of failing an otherwise usable generation.
    expect(current.coverage).toMatchObject({ errorCount: 0, warningCount: 1 });
    expect(current.coverage.findings[0]).toMatchObject({ code: 'orphan-geometry', partIds: ['body'] });
    // Nothing is skinned, so a spec that declared no articulation is recorded as
    // not-ready WITH a reason rather than passing silently.
    expect(current.rig).toMatchObject({ articulationReady: false, jointCount: 0, socketCount: 0 });
    expect(current.rig.reasons).toHaveLength(1);
    // Likewise for clips: a spec that declared none is recorded as a static
    // assembly with nothing to play, never left unevaluated.
    expect(current.animation).toMatchObject({ animated: false, clipCount: 0, sequenceCount: 0 });
    expect(current.runs.at(-1)).toMatchObject({
      status: 'completed',
      runId: 'run-example',
      providerId: 'vision-api',
      model: 'vision-pro',
    });
  });

  it('persists an articulation-ready report when the character declares a usable graph', async () => {
    const characterSpec = {
      ...spec,
      subjectType: 'character',
      sockets: [{ name: 'lensPivot', parentPartId: 'body' }],
      articulation: {
        joints: [
          { id: 'rootJoint', partId: 'body', parentJointId: null },
          { id: 'lensJoint', partId: 'lens', parentJointId: 'rootJoint', pivotSocket: 'lensPivot' },
        ],
        attachmentPartIds: [],
      },
    };
    let current = {
      id: 'threejs-rigged',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      runs: [],
    };
    store.getModel.mockResolvedValue(current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(characterSpec),
      runId: 'run-rigged',
      provider: { id: 'vision-api' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    expect(current.rig).toMatchObject({
      articulationReady: true,
      reasons: [],
      jointCount: 2,
      socketCount: 1,
      rootJointId: 'rootJoint',
      subjectType: 'character',
    });
    // The graph survives the parse onto the record, so the export and the
    // preview read the same joints the report counted.
    expect(current.spec.articulation.joints).toHaveLength(2);
  });

  it('aims an unsteered refinement at the previous pass coverage errors', async () => {
    const fusedSpec = {
      ...spec,
      detailInventory: [
        { ...spec.detailInventory[0], implementationPartIds: ['body'] },
        {
          feature: 'Ribbed collar',
          evidence: 'A ribbed collar wraps the reference object.',
          implementationPartIds: ['body'],
          priority: 'identity',
        },
      ],
    };
    let current = {
      id: 'threejs-fused',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      coverage: null,
      runs: [],
    };
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(fusedSpec),
      runId: 'run-fused',
      provider: { id: 'vision-api' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(current.coverage.errorCount).toBe(1);

    await startGeneration(current.id, { providerId: 'vision-api' });
    expect(current.runs.at(-1).feedback).toContain('assembly-coverage check');
    await vi.waitFor(() => expect(runPromptThroughProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('collapsed onto the single part'),
    })));
  });

  it('records the cross-section gate and folds it into an unsteered refinement', async () => {
    // Both identity features are unbevelled extrudes: a spec that renders
    // correctly from its own camera and like cardboard from anywhere else.
    const slabSpec = {
      ...spec,
      parts: [
        {
          id: 'body',
          name: 'Body',
          geometry: { type: 'extrude', outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]], depth: 0.4 },
          material: 'body',
        },
        {
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'extrude', outline: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4]], depth: 0.2 },
          material: 'lens',
        },
      ],
      detailInventory: [
        { ...spec.detailInventory[0], implementationPartIds: ['lens'] },
        {
          feature: 'Beacon housing',
          evidence: 'A tapered housing carries the lens in the reference.',
          implementationPartIds: ['body'],
          priority: 'identity',
        },
      ],
    };
    let current = {
      id: 'threejs-flat',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      coverage: null,
      flatness: null,
      runs: [],
    };
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(slabSpec),
      runId: 'run-flat',
      provider: { id: 'vision-api' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(current.flatness).toMatchObject({
      warningCount: 1,
      identityDetailCount: 2,
      flatIdentityDetailCount: 2,
    });
    expect(current.flatness.findings[0]).toMatchObject({ code: 'flat-identity-parts' });

    await startGeneration(current.id, { providerId: 'vision-api' });
    expect(current.runs.at(-1).feedback).toContain('cross-section check');
  });

  it('records the cross-part penetration gate and folds it into an unsteered refinement', async () => {
    // The lens is a SIBLING of the body here rather than its child, and it sits
    // entirely inside it — nothing of it can ever be seen.
    const buriedSpec = {
      ...spec,
      parts: [
        {
          id: 'body',
          name: 'Body',
          geometry: { type: 'box', width: 3, height: 3, depth: 3 },
          material: 'body',
        },
        {
          id: 'lens',
          name: 'Lens',
          geometry: { type: 'sphere', radius: 0.35 },
          material: 'lens',
        },
      ],
    };
    let current = {
      id: 'threejs-buried',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      penetration: null,
      runs: [],
    };
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(buriedSpec),
      runId: 'run-buried',
      provider: { id: 'vision-api' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(current.penetration).toMatchObject({ errorCount: 1, evaluatedPartCount: 2, comparedPairCount: 1 });
    expect(current.penetration.findings[0]).toMatchObject({
      code: 'buried-part',
      severity: 'error',
      partIds: ['lens', 'body'],
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    expect(current.runs.at(-1).feedback).toContain('cross-part penetration check');
  });

  it('records the material-plausibility gate and folds it into an unsteered refinement', async () => {
    // The body is named for oak and lit like polished chrome — valid against the
    // schema, implausible against the substance the id names.
    const woodSpec = {
      ...spec,
      materials: {
        ...spec.materials,
        oakBody: { color: '#8b5a2b', metalness: 0.9, roughness: 0.05 },
      },
      parts: spec.parts.map((part) => ({ ...part, material: 'oakBody' })),
    };
    let current = {
      id: 'threejs-materials',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      materialPlausibility: null,
      runs: [],
    };
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(woodSpec),
      runId: 'run-materials',
      provider: { id: 'vision-api' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(current.materialPlausibility).toMatchObject({ errorCount: 0 });
    const woodFinding = current.materialPlausibility.findings.find((finding) => finding.family === 'wood');
    expect(woodFinding).toMatchObject({ code: 'implausible-material-values', materialIds: ['oakBody'] });
    // Nothing is clamped — the stored spec keeps the values the model authored.
    expect(current.spec.materials.oakBody.metalness).toBe(0.9);

    await startGeneration(current.id, { providerId: 'vision-api' });
    expect(current.runs.at(-1).feedback).toContain('do not match the substance');
  });

  it('gives CLI agents a gallery path without passing an API attachment', async () => {
    getProviderById.mockResolvedValue({
      id: 'local-agent',
      name: 'Local Agent',
      type: 'cli',
      enabled: true,
    });
    let current = {
      id: 'threejs-cli',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'local-agent',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      runs: [],
    };
    store.getModel.mockResolvedValue(current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(spec),
      runId: 'run-cli',
      provider: { id: 'local-agent' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'local-agent' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/mock/data',
      screenshots: [],
      prompt: expect.stringContaining('/mock/data/images/example.png'),
    }));
  });

  describe('effort threading', () => {
    // A CLI provider whose CLI has an effort knob (`agy --effort <level>`).
    const agyProvider = {
      id: 'antigravity-cli',
      name: 'Antigravity',
      type: 'cli',
      enabled: true,
      command: 'agy',
    };

    const primeRecord = (overrides = {}) => {
      let current = {
        id: 'threejs-effort',
        name: 'Example Beacon',
        sourceImage: { filename: 'example.png' },
        providerId: 'antigravity-cli',
        model: 'gemini-3.6-flash',
        prompt: '',
        status: 'draft',
        spec: null,
        runs: [],
        ...overrides,
      };
      store.getModel.mockResolvedValue(current);
      store.mutateModel.mockImplementation(async (_id, mutate) => {
        const next = mutate(current);
        if (next) current = next;
        return current;
      });
      runPromptThroughProvider.mockResolvedValue({
        text: JSON.stringify(spec),
        runId: 'run-effort',
        provider: { id: 'antigravity-cli' },
        model: 'gemini-3.6-flash',
      });
      return () => current;
    };

    it('forwards the selected effort to the prompt runner and persists it', async () => {
      getProviderById.mockResolvedValue(agyProvider);
      const read = primeRecord();

      await startGeneration('threejs-effort', {
        providerId: 'antigravity-cli',
        model: 'gemini-3.6-flash',
        effort: 'high',
      });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }));
      expect(read().effort).toBe('high');
      expect(read().runs.at(-1)).toMatchObject({ effort: 'high' });
    });

    it('keeps the stored effort when the caller omits the key entirely', async () => {
      getProviderById.mockResolvedValue(agyProvider);
      const read = primeRecord({ effort: 'medium' });

      await startGeneration('threejs-effort', { providerId: 'antigravity-cli' });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: 'medium' }));
      expect(read().effort).toBe('medium');
    });

    it('drops an effort the resolved provider/model cannot honor instead of persisting a lie', async () => {
      // The picker hides the effort control for a provider with no tiers but
      // keeps its last value, so the request can still carry one.
      getProviderById.mockResolvedValue({
        id: 'vision-api', name: 'Vision API', type: 'api', enabled: true, defaultModel: 'vision-default',
      });
      const read = primeRecord({ providerId: 'vision-api' });

      await startGeneration('threejs-effort', { providerId: 'vision-api', model: 'vision-pro', effort: 'high' });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined }));
      expect(read().effort).toBeNull();
    });

    it('persists the CLAMPED effort when the chosen agy model lacks that tier', async () => {
      getProviderById.mockResolvedValue({
        ...agyProvider,
        models: ['gemini-3.1-pro-low', 'gemini-3.1-pro-high'],
      });
      const read = primeRecord({ model: 'gemini-3.1-pro' });

      // agy rejects `--model gemini-3.1-pro --effort medium`, so it runs as low.
      await startGeneration('threejs-effort', {
        providerId: 'antigravity-cli', model: 'gemini-3.1-pro', effort: 'medium',
      });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low' }));
      expect(read().effort).toBe('low');
    });

    it('clears the stored effort on an explicit null (the picker\'s "Default effort")', async () => {
      getProviderById.mockResolvedValue(agyProvider);
      const read = primeRecord({ effort: 'medium' });

      await startGeneration('threejs-effort', { providerId: 'antigravity-cli', effort: null });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined }));
      expect(read().effort).toBeNull();
    });
  });

  describe('subject-family threading', () => {
    const primeRecord = (overrides = {}) => {
      let current = {
        id: 'threejs-family',
        name: 'Example Beacon',
        sourceImage: { filename: 'example.png' },
        providerId: 'vision-api',
        model: null,
        prompt: '',
        status: 'draft',
        spec: null,
        coverage: null,
        runs: [],
        ...overrides,
      };
      store.getModel.mockImplementation(async () => current);
      store.mutateModel.mockImplementation(async (_id, mutate) => {
        const next = mutate(current);
        if (next) current = next;
        return current;
      });
      runPromptThroughProvider.mockResolvedValue({
        text: JSON.stringify(spec),
        runId: 'run-family',
        provider: { id: 'vision-api' },
        model: null,
      });
      return () => current;
    };

    it('splices the checklist into the prompt and gates coverage on it', async () => {
      const read = primeRecord();

      await startGeneration('threejs-family', { providerId: 'vision-api', family: 'device' });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining('SUBJECT FAMILY — Device / machine'),
      }));
      expect(read().family).toBe('device');
      expect(read().runs.at(-1)).toMatchObject({ family: 'device' });
      // The beacon spec mentions almost nothing a device checklist expects, so
      // the gate fires — which is the whole point of choosing a family.
      expect(read().coverage.family).toMatchObject({ id: 'device' });
      expect(read().coverage.findings.some((f) => f.code === 'missing-family-component')).toBe(true);
    });

    it('keeps the record family when the caller omits the key entirely', async () => {
      const read = primeRecord({ family: 'vehicle' });

      await startGeneration('threejs-family', { providerId: 'vision-api' });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining('SUBJECT FAMILY — Vehicle'),
      }));
      expect(read().family).toBe('vehicle');
    });

    it('turns the checklist back off when the picker sends General', async () => {
      // Unlike effort, `general` is a real value rather than a clear — it is how
      // a user backs out of a family they picked by mistake.
      const read = primeRecord({ family: 'vehicle' });

      await startGeneration('threejs-family', { providerId: 'vision-api', family: 'general' });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.not.stringContaining('SUBJECT FAMILY'),
      }));
      expect(read().family).toBe('general');
      expect(read().coverage.family).toBeNull();
    });

    it('carries an unmentioned component into the next unsteered refinement', async () => {
      const read = primeRecord({ family: 'device' });

      await startGeneration('threejs-family', { providerId: 'vision-api' });
      await vi.waitFor(() => expect(read().status).toBe('ready'));

      await startGeneration('threejs-family', { providerId: 'vision-api' });
      expect(read().runs.at(-1).feedback).toContain('device / machine checklist expects');
    });
  });
});

describe('Three.js model clip inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderById.mockResolvedValue({
      id: 'vision-api',
      name: 'Vision API',
      type: 'api',
      enabled: true,
      defaultModel: 'vision-default',
    });
  });

  it('persists the declared clips alongside the spec, and keeps them on the record', async () => {
    const animatedSpec = {
      ...spec,
      animation: {
        cues: [{ id: 'latchRelease', label: 'Latch lets go', kind: 'latch' }],
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          role: 'deploy',
          durationSeconds: 1.5,
          sequences: [{
            id: 'raiseLens',
            name: 'Raise lens',
            partId: 'lens',
            startSeconds: 0,
            endSeconds: 1,
            channels: { position: { from: [0, 0, 0], to: [0, 0.6, 0] } },
            cueId: 'latchRelease',
          }],
        }],
      },
    };
    let current = {
      id: 'threejs-animated',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      runs: [],
    };
    store.getModel.mockResolvedValue(current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(animatedSpec),
      runId: 'run-animated',
      provider: { id: 'vision-api' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));

    expect(current.animation).toMatchObject({
      animated: true,
      clipCount: 1,
      cueCount: 1,
      sequenceCount: 1,
      movingPartCount: 1,
      longestClipSeconds: 1.5,
    });
    expect(current.animation.clips[0]).toMatchObject({ id: 'deploy', role: 'deploy', cueCount: 1 });
    // The clips survive the parse onto the record, so the export and the preview
    // play the same sequences the inventory counted.
    expect(current.spec.animation.clips[0].sequences).toHaveLength(1);
    // A clip authored against the pose the assembly builds has nothing to fix,
    // so a refinement of it is not steered toward the clips at all.
    expect(current.animation.findings).toEqual([]);
  });

  it('steers an unsteered refinement at a clip that will not play cleanly', async () => {
    const jumpingSpec = {
      ...spec,
      animation: {
        cues: [{ id: 'latchRelease', label: 'Latch lets go', kind: 'latch' }],
        clips: [{
          id: 'deploy',
          name: 'Deploy',
          role: 'deploy',
          durationSeconds: 1.5,
          sequences: [{
            id: 'raiseLens',
            name: 'Raise lens',
            partId: 'lens',
            startSeconds: 0,
            endSeconds: 1,
            // The assembly builds the lens at the origin, so this clip
            // teleports it the instant it opens.
            channels: { position: { from: [0, 0.9, 0], to: [0, 0.6, 0] } },
            cueId: 'latchRelease',
          }],
        }],
      },
    };
    let current = {
      id: 'threejs-clip-feedback',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      animation: null,
      runs: [],
    };
    store.getModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(jumpingSpec),
      runId: 'run-clip-feedback',
      provider: { id: 'vision-api' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'vision-api' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(current.animation.findings.map((finding) => finding.code)).toEqual(['clip-start-pose-mismatch']);
    // A clip finding never rejects the generation — the model is still ready and
    // its spec is stored verbatim.
    expect(current.spec.animation.clips[0].sequences[0].channels.position.from).toEqual([0, 0.9, 0]);

    await startGeneration(current.id, { providerId: 'vision-api' });
    expect(current.runs.at(-1).feedback).toContain('will not play cleanly');
    expect(current.runs.at(-1).feedback).toContain('Lens.position opens at [0, 0.9, 0]');
  });
});

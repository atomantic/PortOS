import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { applyTemplate } from './promptTemplate.js';

// Resolve the templates from disk so the tests exercise the real Prompts
// Manager templates — if a future edit breaks an unwrapped {{var}} or a
// mistyped section name, the test catches it.
const STAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'prompts', 'stages');
const loadStage = async (stageName) => readFile(join(STAGES_DIR, `${stageName}.md`), 'utf-8');

// Mock the prompt-service buildPrompt to render the on-disk template through
// the same engine production uses, without needing a live aiToolkit instance.
vi.mock('../services/promptService.js', () => ({
  buildPrompt: vi.fn(async (stageName, view) => {
    const template = await loadStage(stageName);
    return applyTemplate(template, view);
  }),
}));

const { buildTreatmentPrompt, buildEvaluatePrompt } = await import('./creativeDirectorPrompts.js');

const baseProject = {
  id: 'cd-1',
  name: 'Test Project',
  aspectRatio: '16:9',
  quality: 'standard',
  modelId: 'ltx-video',
  targetDurationSeconds: 30,
  styleSpec: 'neon noir',
  collectionId: 'col-1',
  startingImageFile: null,
  userStory: null,
  treatment: { scenes: [{}, {}, {}] },
};

const baseScene = {
  sceneId: 'scene-2',
  order: 1,
  intent: 'archway opens to reveal city',
  prompt: 'long shot, archway opens',
  durationSeconds: 5,
  useContinuationFromPrior: false,
  retryCount: 0,
  renderedJobId: 'job-abc-123',
};

beforeEach(() => {
  // Templates are loaded fresh from disk — no state to reset.
});

describe('buildTreatmentPrompt — template-rendered output', () => {
  it('renders project header and resolves aspect/quality dimensions', async () => {
    const out = await buildTreatmentPrompt(baseProject);
    expect(out).toContain('# Creative Director — Treatment task');
    expect(out).toContain('"Test Project" (id: cd-1)');
    // Aspect dims come from ASPECT_PRESETS['16:9'] = 768×432.
    expect(out).toContain('Aspect ratio: 16:9 (768×432)');
    // Quality dims from QUALITY_PRESETS.standard = { steps: 20, guidance: 3, fps: 24 }.
    expect(out).toContain('Quality: standard (20 denoising steps, guidance 3, 24fps)');
    expect(out).toContain('Target episode duration: 30s (~1 min)');
  });

  it('uses the "Story" branch when no userStory provided', async () => {
    const out = await buildTreatmentPrompt(baseProject);
    expect(out).toContain('## Story');
    expect(out).toContain('The user did not supply a story');
    expect(out).not.toContain('## User-supplied story');
  });

  it('uses the "User-supplied story" branch when userStory is set', async () => {
    const out = await buildTreatmentPrompt({ ...baseProject, userStory: 'A heist on Mars.' });
    expect(out).toContain('## User-supplied story');
    expect(out).toContain('A heist on Mars.');
    expect(out).not.toContain('The user did not supply a story');
  });

  it('renders sourceImageFile literal as JSON null when no starting image', async () => {
    const out = await buildTreatmentPrompt(baseProject);
    expect(out).toContain('"sourceImageFile": null');
  });

  it('renders sourceImageFile literal as a quoted filename when starting image is set', async () => {
    const out = await buildTreatmentPrompt({ ...baseProject, startingImageFile: 'hero.png' });
    expect(out).toContain('"sourceImageFile": "hero.png"');
    expect(out).toContain('Starting image: /data/images/hero.png');
  });
});

describe('buildEvaluatePrompt — multi-frame sampling', () => {
  it('lists every sampled frame with timeline-position tags when frames are present', async () => {
    const scene = {
      ...baseScene,
      evaluationFrames: [
        'job-abc-123-f1.jpg',
        'job-abc-123-f2.jpg',
        'job-abc-123-f3.jpg',
        'job-abc-123-f4.jpg',
        'job-abc-123-f5.jpg',
      ],
    };
    const out = await buildEvaluatePrompt(baseProject, scene);
    for (const f of scene.evaluationFrames) {
      expect(out).toContain(`/data/video-thumbnails/${f}`);
    }
    expect(out).toContain('start (0%)');
    expect(out).toContain('end (~100%)');
    expect(out).toContain('~50% through');
    expect(out).toContain('Read EACH ONE');
    expect(out).toContain('Read every sampled frame');
    expect(out).toContain('Intent that arrives late still counts as delivered');
  });

  it('falls back to the single thumbnail line when no frames were extracted', async () => {
    const scene = { ...baseScene, evaluationFrames: [] };
    const out = await buildEvaluatePrompt(baseProject, scene);
    expect(out).toContain(`/data/video-thumbnails/${scene.renderedJobId}.jpg`);
    expect(out).toContain('Read the thumbnail using your vision capability');
    expect(out).not.toContain('Read EACH ONE');
  });

  it('falls back when evaluationFrames is missing entirely (legacy projects)', async () => {
    const scene = { ...baseScene };
    delete scene.evaluationFrames;
    const out = await buildEvaluatePrompt(baseProject, scene);
    expect(out).toContain(`/data/video-thumbnails/${scene.renderedJobId}.jpg`);
    expect(out).not.toContain('Sampled frames across the timeline');
  });
});

describe('buildEvaluatePrompt — scene metadata', () => {
  it('includes scene position label, retry budget, and quote-escaped prompt', async () => {
    const scene = {
      ...baseScene,
      evaluationFrames: [],
      retryCount: 1,
      prompt: 'a "smart" prompt with quotes',
    };
    const out = await buildEvaluatePrompt(baseProject, scene);
    expect(out).toContain('Scene id: `scene-2` (2/3)');
    expect(out).toContain('Retry count: 1 (max 3)');
    // promptJson view value is JSON.stringify so embedded quotes are escaped.
    expect(out).toContain('"a \\"smart\\" prompt with quotes"');
    expect(out).toContain('"retryCount": 2');
  });

  it('reports text-to-video strategy when no continuation and no source image', async () => {
    const out = await buildEvaluatePrompt(baseProject, { ...baseScene, evaluationFrames: [] });
    expect(out).toContain('Strategy: text-to-video');
  });

  it('reports continuation strategy when useContinuationFromPrior is true', async () => {
    const out = await buildEvaluatePrompt(baseProject, {
      ...baseScene,
      evaluationFrames: [],
      useContinuationFromPrior: true,
    });
    expect(out).toContain('Strategy: continued from prior scene last-frame');
  });

  it('reports seeded-image strategy when sourceImageFile is set', async () => {
    const out = await buildEvaluatePrompt(baseProject, {
      ...baseScene,
      evaluationFrames: [],
      sourceImageFile: 'hero.png',
    });
    expect(out).toContain('Strategy: seeded from image `hero.png`');
  });
});

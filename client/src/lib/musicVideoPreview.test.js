import { describe, it, expect } from 'vitest';
import { selectMusicVideoPreview, musicVideoImageSrc, musicVideoImageFallback } from './musicVideoPreview.js';
import { summarizeMusicVideoProject } from '../../../server/lib/musicVideoSummary.js';
import { deriveStages, describeProjectStatus } from './musicVideoStages.js';

const animatic = (id, version = 1, over = {}) => ({ id, kind: 'animatic', status: 'pending', version,
  file: `music-video/source-project/dev/${id}/v${version}.mp4`, mimeType: 'video/mp4', bytes: 200,
  versions: [{ version, file: `music-video/source-project/dev/${id}/v${version}.mp4`, mimeType: 'video/mp4', bytes: 200, createdAt: '2026-01-02' }], ...over });

it('surfaces a pinned imported animatic in both full and summary cards without completing production', () => {
  const project = { id: 'review-project', devArtifacts: [animatic('draft-film', 2)], scenes: [], composition: { mode: 'composed' } };
  const preview = selectMusicVideoPreview(project);
  expect(preview).toMatchObject({ source: 'animatic', version: 2, ownerProjectId: 'source-project', reviewStatus: 'pending',
    src: '/api/music-video/review-project/dev-artifacts/draft-film/file?version=2' });
  expect(summarizeMusicVideoProject(project, {}).preview).toEqual(preview);
  const progress = deriveStages(project, null);
  expect(progress.stages.find(stage => stage.id === 'review').state).not.toBe('done');
  const status = describeProjectStatus(project, { progress, reviewingDraft: true });
  // The draft's own review state is shown by ReviewDraftPanel on Final render; the header names the task.
  expect(status).toMatchObject({ headline: 'Imported draft for review', tone: 'muted', needsYouStage: null });
  expect(project.renderHistoryId).toBeUndefined();
});

it('keeps the native final ahead of drafts and rejects invalid, deleted and stale draft revisions', () => {
  const valid = animatic('good-film');
  const candidates = [animatic('removed', 1, { deleted: true }), animatic('stale', 1, { dependencyState: { status: 'stale' } }),
    animatic('wrong-kind', 1, { kind: 'other' }), animatic('missing-version', 1, { versions: [] }),
    animatic('mismatch', 2, { file: 'music-video/source-project/dev/mismatch/v1.mp4' })];
  const project = { id: 'review-project', devArtifacts: [valid, ...candidates] };
  expect(selectMusicVideoPreview(project).artifactId).toBe(valid.id);
  expect(selectMusicVideoPreview({ ...project, devArtifacts: candidates }).kind).toBe('none');
  expect(selectMusicVideoPreview({ ...project, renderHistoryId: 'native-final' }).label).toBe('Final video');
});

it('uses version creation time rather than later notes to choose the latest imported draft', () => {
  const old = animatic('old-film', 1, { updatedAt: '2026-05-01' });
  const newer = animatic('new-film', 1, { versions: [{ ...old.versions[0], file: 'music-video/source-project/dev/new-film/v1.mp4', createdAt: '2026-02-01' }], status: 'changes-requested' });
  expect(selectMusicVideoPreview({ id: 'review-project', devArtifacts: [newer, old] })).toMatchObject({ artifactId: 'new-film', reviewStatus: 'changes-requested' });
});

it('names the review-draft task in the header while checking, resolved or with every draft unavailable', () => {
  const project = { id: 'example', devArtifacts: [animatic('new-film', 3)], scenes: [] };
  const progress = deriveStages(project, null);
  const resolved = { draft: { version: 2, reviewStatus: 'approved' }, unavailableCount: 1, checking: false };
  const status = describeProjectStatus(project, { progress, reviewingDraft: true, reviewDraftState: resolved });
  expect(status.headline).toBe('Imported draft for review');
  expect(describeProjectStatus(project, { progress, reviewingDraft: true, reviewDraftState: { ...resolved, checking: true } }).headline).toBe('Checking review draft');
  const missing = describeProjectStatus(project, { progress, reviewingDraft: true, reviewDraftState: { ...resolved, draft: null } });
  expect(missing.headline).toBe('Choose an available review file');
});

describe('selectMusicVideoPreview', () => {
  it('returns none for null or empty project', () => {
    expect(selectMusicVideoPreview(null)).toEqual({ kind: 'none', label: 'No render yet' });
    expect(selectMusicVideoPreview({})).toEqual({ kind: 'none', label: 'No render yet' });
  });

  it('selects final video render when renderHistoryId is set', () => {
    const project = {
      id: 'p1',
      name: 'Test Project',
      renderHistoryId: 'final-job-123',
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'video',
      source: 'final',
      jobId: 'final-job-123',
      src: '/data/videos/final-job-123.mp4',
      poster: '/data/video-thumbnails/final-job-123.jpg',
      label: 'Final video',
    });
  });

  it('selects latest completed excerpt when no final render is present', () => {
    const project = {
      id: 'p1',
      excerpts: [
        { id: 'e1', status: 'failed', filename: 'fail.mp4' },
        { id: 'e2', status: 'complete', filename: 'excerpt-2.mp4', jobId: 'job-e2', label: 'Bridge preview' },
      ],
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'video',
      jobId: 'job-e2',
      src: '/data/videos/excerpt-2.mp4',
      poster: '/data/video-thumbnails/job-e2.jpg',
      label: 'Bridge preview',
    });
  });

  it('selects latest rendered scene clip when no final render or excerpt exists', () => {
    const project = {
      id: 'p1',
      scenes: [
        { sceneId: 's1', videoHistoryId: 'vid-1' },
        { sceneId: 's2', videoHistoryId: 'vid-2' },
        { sceneId: 's3', videoHistoryId: null },
      ],
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'video',
      jobId: 'vid-2',
      src: '/data/videos/vid-2.mp4',
      poster: '/data/video-thumbnails/vid-2.jpg',
      label: 'Scene 2 clip',
    });
  });

  it('selects latest scene reference frame when no video render exists', () => {
    const project = {
      id: 'p1',
      scenes: [
        { sceneId: 's1', referenceImageId: 'frame-1.png' },
        { sceneId: 's2', referenceImageId: 'frame-2.png' },
      ],
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'image',
      src: '/data/images/frame-2.png',
      fallbackSrc: null,
      label: 'Scene 2 frame',
    });
  });

  it('selects visual spec reference when no scene frame or video exists', () => {
    const project = {
      id: 'p1',
      visualSpec: {
        references: [{ imageId: 'mood-board-ref', label: 'Cyberpunk street' }],
      },
    };
    const preview = selectMusicVideoPreview(project);
    expect(preview).toEqual({
      kind: 'image',
      src: '/data/images/mood-board-ref',
      fallbackSrc: '/data/images/mood-board-ref.png',
      label: 'Cyberpunk street',
    });
  });
});

describe('musicVideoImageSrc and fallback', () => {
  it('handles absolute or schema urls', () => {
    expect(musicVideoImageSrc('/custom/path.png')).toBe('/custom/path.png');
    expect(musicVideoImageSrc('https://example.com/img.png')).toBe('https://example.com/img.png');
    expect(musicVideoImageSrc('image.png')).toBe('/data/images/image.png');
  });

  it('supplies fallback when extension is absent', () => {
    expect(musicVideoImageFallback('img')).toBe('/data/images/img.png');
    expect(musicVideoImageFallback('img.png')).toBe(null);
  });
});

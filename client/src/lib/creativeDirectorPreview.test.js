import { describe, it, expect } from 'vitest';
import {
  selectProjectPreview,
  previewAspectClass,
  previewMaxWidthClass,
  startingImageSrc,
  videoSrcForJob,
  videoPosterForJob,
  imageSrcForJob,
} from './creativeDirectorPreview.js';

// Obviously-fake ids/filenames throughout — never real records from an install.
const scene = (order, renderedJobId = null) => ({ order, renderedJobId, status: 'accepted' });
const step = (toolName, status, result) => ({ stepId: `s-${toolName}-${status}`, toolName, status, result });

describe('previewAspectClass', () => {
  it('maps each locked aspect ratio to a literal Tailwind class', () => {
    expect(previewAspectClass('16:9')).toBe('aspect-video');
    expect(previewAspectClass('9:16')).toBe('aspect-[9/16]');
    expect(previewAspectClass('1:1')).toBe('aspect-square');
  });

  it('falls back to aspect-video for unset/legacy/unknown values', () => {
    expect(previewAspectClass(undefined)).toBe('aspect-video');
    expect(previewAspectClass(null)).toBe('aspect-video');
    expect(previewAspectClass('21:9')).toBe('aspect-video');
  });
});

describe('previewMaxWidthClass', () => {
  it('caps an inline preview by WIDTH per ratio (a max-h would crop it)', () => {
    expect(previewMaxWidthClass('16:9')).toBe('max-w-[calc(60vh*16/9)]');
    expect(previewMaxWidthClass('9:16')).toBe('max-w-[calc(60vh*9/16)]');
    expect(previewMaxWidthClass('1:1')).toBe('max-w-[60vh]');
  });

  it('falls back to the 16:9 cap for unset/unknown values', () => {
    expect(previewMaxWidthClass(undefined)).toBe('max-w-[calc(60vh*16/9)]');
    expect(previewMaxWidthClass('21:9')).toBe('max-w-[calc(60vh*16/9)]');
  });
});

describe('asset path builders', () => {
  it('mirror the worker naming conventions', () => {
    expect(videoSrcForJob('job-1')).toBe('/data/videos/job-1.mp4');
    expect(videoPosterForJob('job-1')).toBe('/data/video-thumbnails/job-1.jpg');
    expect(imageSrcForJob('job-1')).toBe('/data/images/job-1.png');
  });
});

describe('startingImageSrc', () => {
  it('accepts a bare gallery filename', () => {
    expect(startingImageSrc('sample.png')).toBe('/data/images/sample.png');
  });

  it('accepts an already-mounted gallery path', () => {
    expect(startingImageSrc('/data/images/sample.png')).toBe('/data/images/sample.png');
  });

  it('rejects remote and inline schemes', () => {
    expect(startingImageSrc('https://example.com/x.png')).toBeNull();
    expect(startingImageSrc('http://example.com/x.png')).toBeNull();
    expect(startingImageSrc('data:image/png;base64,AAAA')).toBeNull();
    expect(startingImageSrc('blob:abc')).toBeNull();
  });

  it('rejects a non-gallery absolute path', () => {
    expect(startingImageSrc('/data/videos/x.mp4')).toBeNull();
    expect(startingImageSrc('/etc/passwd')).toBeNull();
  });

  it('reduces a traversal-ish value to its basename', () => {
    expect(startingImageSrc('../../secret.png')).toBe('/data/images/secret.png');
    expect(startingImageSrc('/data/images/../../secret.png')).toBe('/data/images/secret.png');
  });

  it('strips a query/hash suffix BEFORE taking the basename, like the server helper', () => {
    // Order matters: basename-first would resolve a slash-bearing suffix as the
    // filename (`photo.png?source=/other.png` → `other.png`), pointing the
    // preview at a different asset than `localImageFilename()` ships.
    expect(startingImageSrc('/data/images/photo.png?source=/other.png')).toBe('/data/images/photo.png');
    expect(startingImageSrc('photo.png?v=2')).toBe('/data/images/photo.png');
    expect(startingImageSrc('/data/images/photo.png#frag')).toBe('/data/images/photo.png');
    expect(startingImageSrc('/data/images/photo.png?a=1#b')).toBe('/data/images/photo.png');
  });

  it('returns null for empty/blank/non-string input', () => {
    expect(startingImageSrc('')).toBeNull();
    expect(startingImageSrc('   ')).toBeNull();
    expect(startingImageSrc(null)).toBeNull();
    expect(startingImageSrc(42)).toBeNull();
  });
});

describe('selectProjectPreview', () => {
  it('returns none for a non-object', () => {
    expect(selectProjectPreview(null)).toEqual({ kind: 'none', label: 'No render yet' });
    expect(selectProjectPreview(undefined).kind).toBe('none');
    expect(selectProjectPreview('nope').kind).toBe('none');
  });

  it('returns none for a bare project with nothing produced', () => {
    expect(selectProjectPreview({ id: 'cd-1', name: 'Example Project' }).kind).toBe('none');
  });

  it('prefers finalVideoId above everything else', () => {
    const preview = selectProjectPreview({
      finalVideoId: 'final-1',
      treatment: { scenes: [scene(0, 'scene-1')] },
      plan: { steps: [step('media_enqueueVideoJob', 'done', { jobId: 'plan-vid' })] },
      startingImageFile: 'start.png',
    });
    expect(preview).toEqual({
      kind: 'video',
      jobId: 'final-1',
      src: '/data/videos/final-1.mp4',
      poster: '/data/video-thumbnails/final-1.jpg',
      label: 'Final video',
    });
  });

  it('falls back to the LAST rendered scene, labeled by its order', () => {
    const preview = selectProjectPreview({
      finalVideoId: null,
      treatment: { scenes: [scene(0, 'scene-a'), scene(1, 'scene-b'), scene(2, null)] },
    });
    expect(preview.kind).toBe('video');
    expect(preview.jobId).toBe('scene-b');
    expect(preview.label).toBe('Scene 2'); // order 1 → "Scene 2"
  });

  it('labels a scene missing `order` by its array index', () => {
    const preview = selectProjectPreview({
      treatment: { scenes: [{ renderedJobId: 'scene-x' }] },
    });
    expect(preview.label).toBe('Scene 1');
  });

  it('ignores scenes with no render and tolerates a missing treatment', () => {
    expect(selectProjectPreview({ treatment: { scenes: [scene(0), scene(1)] } }).kind).toBe('none');
    expect(selectProjectPreview({ treatment: null }).kind).toBe('none');
    expect(selectProjectPreview({ treatment: { scenes: 'bogus' } }).kind).toBe('none');
  });

  it('uses a directive plan\'s last done video step before completion promotes it', () => {
    const preview = selectProjectPreview({
      finalVideoId: null,
      plan: {
        steps: [
          step('media_enqueueVideoJob', 'done', { jobId: 'plan-vid-1' }),
          step('media_enqueueVideoJob', 'done', { jobId: 'plan-vid-2' }),
          step('media_enqueueVideoJob', 'running', null),
        ],
      },
    });
    expect(preview.kind).toBe('video');
    expect(preview.jobId).toBe('plan-vid-2'); // last-wins
    expect(preview.label).toBe('Latest render');
  });

  it('skips plan steps that are not done or carry no jobId', () => {
    expect(selectProjectPreview({
      plan: {
        steps: [
          step('media_enqueueVideoJob', 'failed', { jobId: 'nope' }),
          step('media_enqueueVideoJob', 'done', { error: 'boom' }),
          step('media_enqueueVideoJob', 'running', { jobId: 'not-yet' }),
        ],
      },
    }).kind).toBe('none');
  });

  it('falls back to a produced image for an image-emitting plan (e.g. a comic)', () => {
    const preview = selectProjectPreview({
      plan: {
        steps: [
          step('media_enqueueImageJob', 'done', { jobId: 'img-1' }),
          step('media_enqueueImageJob', 'done', { jobId: 'img-2' }),
        ],
      },
    });
    expect(preview).toEqual({
      kind: 'image',
      jobId: 'img-2',
      src: '/data/images/img-2.png',
      label: 'Produced image',
    });
  });

  it('prefers a plan video over a plan image', () => {
    const preview = selectProjectPreview({
      plan: {
        steps: [
          step('media_enqueueImageJob', 'done', { jobId: 'img-1' }),
          step('media_enqueueVideoJob', 'done', { jobId: 'vid-1' }),
        ],
      },
    });
    expect(preview.kind).toBe('video');
    expect(preview.jobId).toBe('vid-1');
  });

  it('prefers a rendered scene over a plan step', () => {
    const preview = selectProjectPreview({
      treatment: { scenes: [scene(0, 'scene-a')] },
      plan: { steps: [step('media_enqueueVideoJob', 'done', { jobId: 'plan-vid' })] },
    });
    expect(preview.jobId).toBe('scene-a');
  });

  it('falls back to the starting image, labeled as an input not a render', () => {
    const preview = selectProjectPreview({ startingImageFile: 'start.png' });
    expect(preview).toEqual({ kind: 'image', src: '/data/images/start.png', label: 'Starting image' });
  });

  it('marks a PRODUCED image with a jobId and a starting image WITHOUT one', () => {
    // `jobId` is the discriminator between the two `kind: 'image'` cases —
    // OverviewTab gates its hero section on it so a user-supplied input image
    // never gets promoted as if the director produced it. Don't "helpfully"
    // start setting jobId on the starting-image branch.
    const produced = selectProjectPreview({
      plan: { steps: [step('media_enqueueImageJob', 'done', { jobId: 'img-1' })] },
    });
    const starting = selectProjectPreview({ startingImageFile: 'start.png' });
    expect(produced.kind).toBe('image');
    expect(produced.jobId).toBe('img-1');
    expect(starting.kind).toBe('image');
    expect(starting.jobId).toBeUndefined();
  });

  it('does not use an unservable starting image', () => {
    expect(selectProjectPreview({ startingImageFile: 'https://example.com/x.png' }).kind).toBe('none');
  });

  it('never resolves a cast portrait — cast members carry no image ref', () => {
    // Guards the documented gap: portraits live on the catalog ingredient, and
    // resolving one would need a per-card fetch (out of scope for #2702).
    const preview = selectProjectPreview({
      cast: [{ ingredientId: 'ing-1', name: 'Example Character', type: 'character', role: 'lead' }],
    });
    expect(preview.kind).toBe('none');
  });

  it('tolerates a malformed plan', () => {
    expect(selectProjectPreview({ plan: null }).kind).toBe('none');
    expect(selectProjectPreview({ plan: { steps: 'bogus' } }).kind).toBe('none');
    expect(selectProjectPreview({ plan: { steps: [null, undefined] } }).kind).toBe('none');
  });
});

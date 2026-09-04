// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { resolveVideoRenderSteps, videoRenderStepFor } from './videoRenderPhase';

const activeLabel = (result) => result.steps.find((step) => step.state === 'active')?.label ?? null;

describe('videoRenderStepFor', () => {
  it('collapses each runner phase family onto its coarse step', () => {
    expect(videoRenderStepFor('download-text-encoder')).toBe('download');
    expect(videoRenderStepFor('load-transformer')).toBe('load');
    expect(videoRenderStepFor('encode-prompt')).toBe('encode');
    expect(videoRenderStepFor('sampling')).toBe('render');
    expect(videoRenderStepFor('mux')).toBe('finalize');
  });

  // Matching the family prefix is what keeps the table from silently rotting:
  // runners keep adding markers within families they already emit.
  it('absorbs unseen markers within a known family via its prefix', () => {
    expect(videoRenderStepFor('download-some-new-shard')).toBe('download');
    expect(videoRenderStepFor('load-audio-vae')).toBe('load');
    expect(videoRenderStepFor('swap-video-decoder')).toBe('load');
    // generate_wan22.py emits STAGE:wan-i2v / STAGE:wan-t2v, never bare "wan".
    expect(videoRenderStepFor('wan-i2v')).toBe('render');
    expect(videoRenderStepFor('ref2va-mux')).toBe('render');
  });

  // Each of these was wrong before the exact/bare entries were added, and each
  // mislabels the LONGEST phase of a real render.
  it('maps the phases the shipped runners actually pin during their slowest work', () => {
    // `DOWNLOAD:` lines and hf_download_repo.py both pin the BARE marker, which
    // does not match the `download-` prefix.
    expect(videoRenderStepFor('download')).toBe('download');
    // generate_ltx2.py's LAST stage marker before denoising. It means the
    // encode FINISHED, so the `encode-prompt` prefix would read it backwards
    // and leave LTX-2 showing "Encoding prompt" for its entire sampler run.
    expect(videoRenderStepFor('encode-prompt-done')).toBe('render');
    // generate_fastvideo.py's conditioning phase is named 'conditioning'
    // precisely so it can't collide with ltx2's prompt-encode sentinel.
    expect(videoRenderStepFor('conditioning')).toBe('encode');
  });

  // A runner is free to emit any STAGE id; one that collides with an
  // Object.prototype key must not resolve to a function the caller then treats
  // as a step id (and whose step list comes back undefined to .map over).
  it('is not fooled by a phase named after an Object.prototype key', () => {
    expect(videoRenderStepFor('constructor')).toBeNull();
    expect(videoRenderStepFor('toString')).toBeNull();
    expect(resolveVideoRenderSteps({ generating: true, phase: 'constructor' }).steps)
      .toHaveLength(6);
  });

  it('normalizes case, because BYOV helpers are not required to agree on it', () => {
    expect(videoRenderStepFor('Load-Pipeline')).toBe('load');
  });

  // An unknown marker must not resolve to the FIRST step: a render that jumped
  // back to "Queued" mid-flight reads as having lost its work.
  it('returns null for an unrecognized phase rather than the first step', () => {
    expect(videoRenderStepFor('some-future-marker')).toBeNull();
    expect(videoRenderStepFor('')).toBeNull();
    expect(videoRenderStepFor(undefined)).toBeNull();
  });
});

describe('resolveVideoRenderSteps', () => {
  it('marks earlier steps done and later ones pending', () => {
    const { activeId, steps } = resolveVideoRenderSteps({ generating: true, phase: 'sampling' });
    expect(activeId).toBe('render');
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'active', 'pending']);
  });

  it('shows nothing active when no render is running', () => {
    const { activeId, steps } = resolveVideoRenderSteps({ generating: false, phase: 'sampling' });
    expect(activeId).toBeNull();
    expect(steps.every((s) => s.state === 'pending')).toBe(true);
  });

  it('treats the queue as one more phase rather than a separate flag', () => {
    expect(activeLabel(resolveVideoRenderSteps({ generating: true, phase: 'queued' }))).toBe('Queued');
  });

  // The regression this whole card exists for: FastH3 streams an ~89 GB
  // checkpoint before its first denoise step and reports no phase and no
  // progress while it does. "Loading model" is the truthful default there —
  // "Rendering" would be a lie and a blank would be the old bug.
  it('defaults a started-but-silent render to loading, not rendering', () => {
    expect(activeLabel(resolveVideoRenderSteps({ generating: true }))).toBe('Loading model');
  });

  it('treats visible numeric progress as rendering when no phase arrived', () => {
    expect(activeLabel(resolveVideoRenderSteps({ generating: true, progressPct: 12 }))).toBe('Rendering');
    // 0% is what the page seeds before the first frame — not evidence of work.
    expect(activeLabel(resolveVideoRenderSteps({ generating: true, progressPct: 0 }))).toBe('Loading model');
  });
});

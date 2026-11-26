import { describe, it, expect, vi } from 'vitest';

const kill = vi.hoisted(() => vi.fn());
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: kill }));

import { cancelMusicVideoRenderJob, isMusicVideoRenderCancelPending } from './renderCancellation.js';

const running = (extra = {}) => ({ status: 'running', process: null, overlayAbort: new AbortController(), ...extra });

describe('cancelMusicVideoRenderJob', () => {
  it('cancels in a phase gap with no child process, aborting the job-lifetime signal', () => {
    const job = running();
    expect(cancelMusicVideoRenderJob(job, { label: 't' })).toBe(true);
    expect(job.cancelRequested).toBe(true);
    expect(job.overlayAbort.signal.aborted).toBe(true);
    expect(isMusicVideoRenderCancelPending(job)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it('records the request and kills a live encode', () => {
    const proc = {};
    const job = running({ process: proc });
    expect(cancelMusicVideoRenderJob(job, { label: 't' })).toBe(true);
    expect(job.cancelRequested).toBe(true);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('refuses once committing or settled, leaving the job untouched', () => {
    const committing = running({ committing: true });
    expect(cancelMusicVideoRenderJob(committing, { label: 't' })).toEqual({ ok: false, code: 'ALREADY_TERMINAL' });
    expect(committing.cancelRequested).toBeUndefined();
    expect(committing.overlayAbort.signal.aborted).toBe(false);
    expect(cancelMusicVideoRenderJob(running({ status: 'complete' }), { label: 't' })).toEqual({ ok: false, code: 'ALREADY_TERMINAL' });
    expect(cancelMusicVideoRenderJob(undefined, { label: 't' })).toBe(false);
  });
});

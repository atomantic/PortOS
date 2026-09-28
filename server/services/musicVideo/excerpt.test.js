import { describe, it, expect } from 'vitest';
import {
  startExcerptOnProject,
  applyExcerptPatch,
  removeExcerptFromProject,
  addExcerptNote,
  updateExcerptNote,
  removeExcerptNote,
  projectExcerpts,
} from './excerpt.js';

const project = (over = {}) => ({ id: 'mv-1', name: 'Example Video', ...over });
const findExcerpt = (proj, excerptId) => projectExcerpts(proj).find((e) => e.id === excerptId);

describe('startExcerptOnProject (#8986)', () => {
  it('appends a status: rendering excerpt whose id doubles as the job id', () => {
    const { project: next, excerpt } = startExcerptOnProject(project(), { startSec: 10, endSec: 15 });
    expect(excerpt.status).toBe('rendering');
    expect(excerpt.jobId).toBe(excerpt.id);
    expect(excerpt.startSec).toBe(10);
    expect(excerpt.endSec).toBe(15);
    expect(excerpt.notes).toEqual([]);
    expect(projectExcerpts(next)).toEqual([excerpt]);
  });

  it('rejects a non-forward range', () => {
    expect(() => startExcerptOnProject(project(), { startSec: 10, endSec: 10 })).toThrow(/endSec/);
    expect(() => startExcerptOnProject(project(), { startSec: 10, endSec: 5 })).toThrow(/endSec/);
  });

  it('preserves any existing excerpts', () => {
    const { project: withOne, excerpt: first } = startExcerptOnProject(project(), { startSec: 0, endSec: 5 });
    const { project: withTwo } = startExcerptOnProject(withOne, { startSec: 5, endSec: 10 });
    expect(projectExcerpts(withTwo)).toHaveLength(2);
    expect(projectExcerpts(withTwo)[0]).toEqual(first);
  });
});

describe('applyExcerptPatch', () => {
  it('merges a patch onto the named excerpt only, bumping updatedAt', () => {
    const { project: seeded, excerpt } = startExcerptOnProject(project(), { startSec: 0, endSec: 5 });
    const patched = applyExcerptPatch(seeded, excerpt.id, { status: 'complete', filename: 'out.mp4' });
    const found = findExcerpt(patched, excerpt.id);
    expect(found.status).toBe('complete');
    expect(found.filename).toBe('out.mp4');
  });

  it('404s on an unknown excerpt id', () => {
    expect(() => applyExcerptPatch(project({ excerpts: [] }), 'nope', { status: 'error' })).toThrow(/not found/i);
  });
});

describe('removeExcerptFromProject', () => {
  it('drops the excerpt and returns it for on-disk cleanup', () => {
    const { project: seeded, excerpt } = startExcerptOnProject(project(), { startSec: 0, endSec: 5 });
    const complete = applyExcerptPatch(seeded, excerpt.id, { status: 'complete', filename: 'out.mp4' });
    const { project: next, excerpt: removed } = removeExcerptFromProject(complete, excerpt.id);
    expect(projectExcerpts(next)).toEqual([]);
    expect(removed.filename).toBe('out.mp4');
  });

  it('refuses to remove an excerpt whose render is still in flight', () => {
    const { project: seeded, excerpt } = startExcerptOnProject(project(), { startSec: 0, endSec: 5 });
    expect(() => removeExcerptFromProject(seeded, excerpt.id)).toThrow(/cancel/i);
  });
});

describe('review notes', () => {
  function seededExcerpt() {
    const { project: seeded, excerpt } = startExcerptOnProject(project(), { startSec: 10, endSec: 20 }); // 10s excerpt
    return { project: applyExcerptPatch(seeded, excerpt.id, { status: 'complete', filename: 'out.mp4' }), excerptId: excerpt.id };
  }

  it('adds a timecoded note against the excerpt\'s own timeline', () => {
    const { project, excerptId } = seededExcerpt();
    const { project: next, note } = addExcerptNote(project, excerptId, { atSec: 3.5, note: 'lip-sync drifts here', verdict: 'flagged' });
    expect(note.atSec).toBe(3.5);
    expect(note.verdict).toBe('flagged');
    expect(findExcerpt(next, excerptId).notes).toEqual([note]);
  });

  it('rejects a blank note', () => {
    const { project, excerptId } = seededExcerpt();
    expect(() => addExcerptNote(project, excerptId, { atSec: 1, note: '   ' })).toThrow(/text/i);
  });

  it('rejects a timecode well past the excerpt\'s own duration', () => {
    const { project, excerptId } = seededExcerpt();
    expect(() => addExcerptNote(project, excerptId, { atSec: 11, note: 'past the end' })).toThrow(/duration/i);
  });

  it('tolerates a timecode a fraction of a second past the end (encoder/player rounding)', () => {
    const { project, excerptId } = seededExcerpt();
    const { note } = addExcerptNote(project, excerptId, { atSec: 10.1, note: 'right at the last frame' });
    expect(note.atSec).toBe(10); // clamped to the excerpt's own span
  });

  it('edits a note\'s text/verdict and can clear the verdict back to null', () => {
    const { project, excerptId } = seededExcerpt();
    const { project: withNote, note } = addExcerptNote(project, excerptId, { atSec: 2, note: 'first pass' });
    const { note: edited } = updateExcerptNote(withNote, excerptId, note.id, { note: 'resolved on re-render', verdict: 'approved' });
    expect(edited.note).toBe('resolved on re-render');
    expect(edited.verdict).toBe('approved');
    const { note: cleared } = updateExcerptNote(withNote, excerptId, note.id, { verdict: null });
    expect(cleared.verdict).toBeNull();
  });

  it('removes a note', () => {
    const { project, excerptId } = seededExcerpt();
    const { project: withNote, note } = addExcerptNote(project, excerptId, { atSec: 2, note: 'first pass' });
    const next = removeExcerptNote(withNote, excerptId, note.id);
    expect(findExcerpt(next, excerptId).notes).toEqual([]);
  });

  it('404s editing/removing an unknown note', () => {
    const { project, excerptId } = seededExcerpt();
    expect(() => updateExcerptNote(project, excerptId, 'nope', { note: 'x' })).toThrow(/not found/i);
    expect(() => removeExcerptNote(project, excerptId, 'nope')).toThrow(/not found/i);
  });
});

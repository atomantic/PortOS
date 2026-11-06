import { describe, expect, it } from 'vitest';
import {
  musicVideoClipConditioningReferences, musicVideoClipReferenceChoices, musicVideoConditioningReferences,
  musicVideoFrameReferenceFiles, musicVideoLimitReferenceFiles, musicVideoLinkedCastIds, musicVideoLinkedCastReferences, musicVideoLinkedReferenceId, musicVideoMissingFrameLinkedPicks,
  musicVideoOfferedReferences, musicVideoReferenceCapacity, musicVideoSceneCastIds,
} from './musicVideoConditioning.js';

const CAST = 'cat-chr-lead';
const subject = { id: 'lead', kind: 'character', name: 'Lead', ingredientId: CAST };
const project = (extra = {}) => ({ concept: { subjects: [subject] }, visualSpec: { references: [] }, ...extra });
const media = [
  { kind: 'portrait', mediaKey: 'portrait.png', library: { review: { status: 'good' } } },
  { kind: 'reference', role: 'sheet:face', mediaKey: 'face.png' },
  { kind: 'reference', role: 'sheet:standard', mediaKey: 'sheet.png' },
  { kind: 'reference', role: 'design:1', mediaKey: 'portrait.png', library: { guide: true } },
  { kind: 'reference', role: 'design:2', mediaKey: 'candidate.png', library: { review: { status: 'unreviewed' } } },
  { kind: 'reference', mediaKey: 'good.png', library: { review: { status: 'good' }, variant: { label: 'Stage look' } } },
  { kind: 'reference', role: 'sheet:photographic', mediaKey: 'bad-sheet.png', library: { review: { status: 'bad' } } },
  { kind: 'reference', mediaKey: 'left-out.png', library: { guide: false, likeness: false } },
  { kind: 'reference', role: 'archive:old', mediaKey: 'archived.png', library: { guide: true } },
  { kind: 'reference', role: 'sheet:face', mediaKey: 'deleted.png', deleted: true },
  { kind: 'reference', role: 'sheet:face', mediaKey: 'clip.mp4' },
  { kind: 'reference', role: 'sheet:face@child', mediaKey: 'child-face.png' },
  { kind: 'reference', mediaKey: 'child-good.png', library: { review: { status: 'good' }, variant: { formId: 'child' } } },
];
const castMedia = { [CAST]: media };
const linkedId = musicVideoLinkedReferenceId;

describe('catalog assets offered for a linked character', () => {
  // Uniquely catches a linked character offering only its portrait, or an unapproved image reaching a shot.
  it('offers the portrait, sheets, guides and good references of the canonical form only', () => {
    const refs = musicVideoLinkedCastReferences(project(), castMedia);
    expect(refs.map((ref) => ref.imageId)).toEqual(['portrait.png', 'face.png', 'sheet.png', 'good.png']);
    expect(refs.map((ref) => ref.label)).toEqual(['Lead · Portrait', 'Lead · Face sheet', 'Lead · Character sheet', 'Lead · Stage look']);
  });

  it('offers only the selected age or look when the subject links one', () => {
    const linked = project({ concept: { subjects: [{ ...subject, castForm: { id: 'child' } }] } });
    expect(musicVideoLinkedCastReferences(linked, castMedia).map((ref) => ref.imageId)).toEqual(['child-face.png', 'child-good.png']);
  });

  // Uniquely catches a linked set or prop missing from the picker, or offered under the wrong role.
  it('covers every linked character, set and prop, and skips subjects that are not linked', () => {
    const other = { id: 'other', kind: 'character', name: 'Other', ingredientId: 'cat-chr-other' };
    const linked = project({ concept: { subjects: [subject, other, { id: 'set', kind: 'place', name: 'Rink', ingredientId: 'cat-plc' }, { id: 'bike', kind: 'object', name: 'Bike', ingredientId: 'cat-obj' }, { id: 'free', kind: 'character', name: 'Free' }, { id: 'mood', kind: 'mood', name: 'Mood', ingredientId: 'cat-mood' }] } });
    expect(musicVideoLinkedCastIds(linked)).toEqual([CAST, 'cat-chr-other', 'cat-plc', 'cat-obj']);
    const refs = musicVideoLinkedCastReferences(linked, { ...castMedia, 'cat-chr-other': [{ kind: 'reference', role: 'sheet:face', mediaKey: 'other-face.png' }],
      'cat-plc': [{ kind: 'portrait', mediaKey: 'set.png' }, { kind: 'reference', role: 'sheet:standard', mediaKey: 'set-sheet.png' }, { kind: 'reference', mediaKey: 'set-unreviewed.png' }],
      'cat-obj': [{ kind: 'portrait', mediaKey: 'bike.png' }], 'cat-mood': [{ kind: 'portrait', mediaKey: 'mood.png' }] });
    expect(refs.map((ref) => ref.imageId)).toEqual(['portrait.png', 'face.png', 'sheet.png', 'good.png', 'other-face.png', 'set.png', 'set-sheet.png', 'bike.png']);
    expect(refs.slice(-3).map(({ role, label, castGuide }) => [role, label, castGuide])).toEqual([
      ['set', 'Rink · Canonical image', undefined], ['set', 'Rink · Set sheet', undefined], ['prop', 'Bike · Canonical image', undefined]]);
  });

  it('stays out of the automatic set until the director picks one', () => {
    const scene = { prompt: 'Lead walks in' };
    expect(musicVideoConditioningReferences(project(), scene, castMedia)).toEqual([]);
    expect(musicVideoClipConditioningReferences(project(), scene, castMedia)).toEqual([]);
  });

  // Uniquely catches a pick that shows in the picker but is dropped when the render resolves it.
  it('resolves a picked asset for frames and clips, and loads its media for that scene', () => {
    const scene = { frameReferenceIds: [linkedId('face.png')], clipReferenceIds: [linkedId('sheet.png')] };
    expect(musicVideoConditioningReferences(project(), scene, castMedia).map((ref) => ref.imageId)).toEqual(['face.png']);
    expect(musicVideoClipConditioningReferences(project(), scene, castMedia).map((ref) => ref.imageId)).toEqual(['sheet.png']);
    expect(musicVideoClipReferenceChoices(project(), scene, castMedia).some((ref) => ref.id === linkedId('sheet.png'))).toBe(true);
    expect(musicVideoSceneCastIds(project(), scene)).toEqual([CAST]);
    expect(musicVideoSceneCastIds(project(), {})).toEqual([]);
  });

  it('keeps a pick within a five-image renderer in the chosen order', () => {
    const scene = { frameReferenceIds: ['r1', 'r2', 'r3', 'r4', 'r5', linkedId('face.png')] };
    const withRefs = project({ visualSpec: { references: ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ id, imageId: `${id}.png`, role: 'set' })) } });
    const files = musicVideoFrameReferenceFiles(null, musicVideoConditioningReferences(withRefs, scene, castMedia));
    expect(files).toHaveLength(6);
    expect(musicVideoLimitReferenceFiles(files, musicVideoReferenceCapacity('codex'))).toEqual(['r1.png', 'r2.png', 'r3.png', 'r4.png', 'r5.png']);
  });

  // Uniquely catches a truncated id, where picking one long filename sends another.
  it('gives long filenames that share a prefix their own ids', () => {
    const prefix = `portrait_${'a'.repeat(120)}`;
    const rows = [`${prefix}_face.png`, `${prefix}_fullbody.png`].map((mediaKey) => ({ kind: 'reference', role: 'sheet:face', mediaKey }));
    const refs = musicVideoLinkedCastReferences(project(), { [CAST]: rows });
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(2);
    expect(refs.every((ref) => ref.id.length <= 128)).toBe(true);
    const scene = { frameReferenceIds: [refs[1].id] };
    expect(musicVideoConditioningReferences(project(), scene, { [CAST]: rows }).map((ref) => ref.imageId)).toEqual([rows[1].mediaKey]);
  });

  // Uniquely catches a paid frame render that silently loses the sheet the director picked.
  it('reports a picked asset that does not resolve', () => {
    const scene = { frameReferenceIds: ['own', linkedId('face.png')] };
    expect(musicVideoMissingFrameLinkedPicks(project(), scene, castMedia)).toEqual([]);
    expect(musicVideoMissingFrameLinkedPicks(project(), scene, null)).toEqual([linkedId('face.png')]);
    expect(musicVideoMissingFrameLinkedPicks(project(), scene, { [CAST]: null })).toEqual([linkedId('face.png')]);
    expect(musicVideoMissingFrameLinkedPicks(project(), scene, { [CAST]: [{ ...media[1], library: { review: { status: 'bad' } } }] })).toEqual([linkedId('face.png')]);
    expect(musicVideoMissingFrameLinkedPicks(project(), { }, null)).toEqual([]);
  });

  it('offers an image once, keeping the project reference that already holds it', () => {
    const offered = musicVideoOfferedReferences([{ id: 'own', imageId: 'portrait.png', role: 'character' }, ...musicVideoLinkedCastReferences(project(), castMedia)]);
    expect(offered.map((ref) => ref.id)).toEqual([linkedId('face.png'), linkedId('sheet.png'), linkedId('good.png'), 'own']);
  });
});

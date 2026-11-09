import { describe, expect, it } from 'vitest';
import { currentPlateEvidence, plateRequirements, plateReviewEvidence, selectedPlatePasses } from './musicVideoPlateEvidence.js';

const subjects = [
  { id: 'a', kind: 'character', name: 'Ada', requiredDetails: ['Red watch on the left wrist', 'Camera on a wrist strap'] },
  { id: 'b', kind: 'character', name: 'Bo', requiredDetails: ['Blue cap'] },
  { id: 'b2', kind: 'character', name: 'Bo', active: false, requiredDetails: ['Green scarf'] },
  { id: 'p', kind: 'object', name: 'Lamp', requiredDetails: ['Never checked for objects'] },
];
const scene = (sheet) => ({ sceneId: 's1', startSec: 0, endSec: 2, framePrompt: 'Ada on a bike.', shotSheet: sheet });
const plateDetailRequirements = (shot, list, project = null) => plateRequirements(shot, list, 'start', project).filter((entry) => entry.id.startsWith('detail-'));
const pass = (list) => JSON.stringify({ checks: list.map(({ id }) => ({ id, status: 'pass', note: 'Visible' })) });

describe('character detail requirements', () => {
  it('requires each named character\'s details and skips characters not in the shot', () => {
    expect(plateDetailRequirements(scene({ characters: ['Ada'] }), subjects).map((entry) => entry.requirement)).toEqual([
      'Ada shows: Red watch on the left wrist',
      'Ada shows: Camera on a wrist strap',
    ]);
  });

  it('uses only the active alternate and never objects', () => {
    const lines = plateDetailRequirements(scene({ characters: ['Bo'] }), subjects).map((entry) => entry.requirement);
    expect(lines).toEqual(['Bo shows: Blue cap']);
  });

  it('makes the point-of-view holder conditional on their hands showing', () => {
    expect(plateDetailRequirements(scene({ characters: [], holder: 'Ada' }), subjects)[0].requirement)
      .toBe("If Ada's hands or arms are visible, they show: Red watch on the left wrist");
  });

  // Catches a selfie still being required to show the camera that is taking it (#15586).
  it('drops the shooting camera from its owner and holder, and checks the same camera rule', () => {
    const project = { cameras: [{ id: 'snap', name: 'Snapshot camera', kind: 'in-world', owner: 'Ada', rule: 'Facing back.' }] };
    const cast = subjects.map((subject) => (subject.id === 'b' ? { ...subject, requiredDetails: ['Blue cap', 'Pocket camera'] } : subject));
    const selfie = scene({ characters: ['Ada', 'Bo'], holder: 'Ada', cameraId: 'snap' });
    expect(plateDetailRequirements(selfie, cast, project).map((entry) => entry.requirement)).toEqual([
      'Ada shows: Red watch on the left wrist',
      'Bo shows: Blue cap',
      'Bo shows: Pocket camera',
      'Camera: Snapshot camera, an in-world camera. This camera is the one taking the picture, so it is not in the frame. Facing back.',
    ]);
    const borrowed = scene({ characters: ['Ada', 'Bo'], holder: 'Bo', cameraId: 'snap' });
    expect(plateDetailRequirements(borrowed, cast, project).map((entry) => entry.requirement)).toEqual([
      'Ada shows: Red watch on the left wrist',
      'Bo shows: Blue cap',
      'Camera: Snapshot camera, an in-world camera. This camera is the one taking the picture, so it is not in the frame. Facing back.',
    ]);
  });

  it('adds details before the render-quality check and keeps the shot-only list unchanged', () => {
    const shot = scene({ characters: ['Ada'] });
    expect(plateRequirements(shot).map((entry) => entry.id)).toEqual(['plate-prompt', 'render-quality']);
    expect(plateRequirements(shot, subjects).map((entry) => entry.id)).toEqual(['plate-prompt', 'detail-1', 'detail-2', 'render-quality']);
  });

  it('keeps evidence with detail checks current and blocks the plate when a detail fails', () => {
    const shot = scene({ characters: ['Ada'] });
    const requirements = plateRequirements(shot, subjects);
    const passed = plateReviewEvidence(shot, 'a.png', 'run-1', pass(requirements), {}, subjects);
    const take = { kind: 'image', assetId: 'a.png', plateEvidence: passed };
    expect(currentPlateEvidence(shot, take)?.verdict).toBe('pass');
    expect(selectedPlatePasses({ ...shot, referenceImageId: 'a.png', takes: [take] }, 'run-1')).toBe(true);

    const failed = plateReviewEvidence(shot, 'a.png', 'run-1', JSON.stringify({ checks: requirements.map(({ id }) => ({ id, status: id === 'detail-1' ? 'fail' : 'pass', note: id === 'detail-1' ? 'No watch' : 'Visible' })) }), {}, subjects);
    const failedTake = { kind: 'image', assetId: 'a.png', plateEvidence: failed };
    expect(currentPlateEvidence(shot, failedTake)?.verdict).toBe('fail');
    expect(selectedPlatePasses({ ...shot, referenceImageId: 'a.png', takes: [failedTake] }, 'run-1')).toBe(false);
  });

  it('rejects evidence with a malformed detail check', () => {
    const shot = scene({ characters: ['Ada'] });
    const evidence = plateReviewEvidence(shot, 'a.png', 'run-1', pass(plateRequirements(shot, subjects)), {}, subjects);
    const broken = { ...evidence, checks: evidence.checks.map((check) => (check.id === 'detail-1' ? { ...check, note: '' } : check)) };
    expect(currentPlateEvidence(shot, { kind: 'image', assetId: 'a.png', plateEvidence: broken })).toBeNull();
  });
});

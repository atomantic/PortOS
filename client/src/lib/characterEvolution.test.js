import { describe, it, expect } from 'vitest';
import {
  CHARACTER_EVOLUTION_LIMITS,
  EVOLUTION_EVIDENCE_FIELDS,
  EVOLUTION_OUTCOMES,
  EVOLUTION_OUTCOME_HINTS,
  EVOLUTION_STAGES,
  EVOLUTION_STAGE_EDITOR_FIELDS,
  EVOLUTION_STAGE_LABELS,
  EVOLUTION_STAGE_TEXT_FIELDS,
} from './characterEvolution.js';

// The editor copy is hand-written here while the vocabularies are re-exported
// from the server leaf, so these assert the half that CAN drift: a descriptor
// naming a field, stage or outcome the server does not have would render an
// input whose value the sanitizer silently drops. (The re-exports themselves
// are guarded on the server side, where a source check can tell a re-export
// from a hand-copied literal.)
describe('editor descriptors track the shared vocabularies', () => {
  it('gives every stage a label and every outcome a hint', () => {
    expect(Object.keys(EVOLUTION_STAGE_LABELS).sort()).toEqual([...EVOLUTION_STAGES].sort());
    expect(Object.keys(EVOLUTION_OUTCOME_HINTS).sort()).toEqual([...EVOLUTION_OUTCOMES].sort());
  });

  it('describes exactly the four authored stage fields, at the server caps', () => {
    expect(EVOLUTION_STAGE_EDITOR_FIELDS.map((f) => f.name)).toEqual([...EVOLUTION_STAGE_TEXT_FIELDS]);
    for (const field of EVOLUTION_STAGE_EDITOR_FIELDS) {
      expect(field.max, field.name).toBe(CHARACTER_EVOLUTION_LIMITS[field.name]);
      expect(field.label && field.placeholder, field.name).toBeTruthy();
    }
  });

  it('splits the anchor vocabulary by host without overlap', () => {
    const { pipelineSeries, fableLoom } = EVOLUTION_EVIDENCE_FIELDS;
    expect(pipelineSeries.some((name) => fableLoom.includes(name))).toBe(false);
  });
});

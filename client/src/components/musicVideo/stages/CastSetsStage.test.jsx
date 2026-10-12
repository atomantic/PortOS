import { describe, it, expect } from 'vitest';
import { directionSummary } from './CastSetsStage.jsx';

describe('Creative direction summary', () => {
  // Uniquely catches an original cast lead reading as missing data ("No character style").
  it('names the original lead when no character style preset is chosen', () => {
    const concept = { prompt: 'A film editor', style: 'Analog', subjects: [{ name: 'Example lead', role: 'protagonist' }] };
    expect(directionSummary({ concept })).toBe('Original character: Example lead · Concept written · Visual style set · No look references');
    expect(directionSummary({ concept: { ...concept, characterStyleId: 'preset', characterStyle: 'Preset name: details' } })).toMatch(/^Character style: Preset name ·/);
    expect(directionSummary({ concept: { prompt: 'x', style: 'y' } })).toBe('Concept written · Visual style set · No look references');
  });
});

import { describe, expect, it } from 'vitest';
import { __testing } from './scriptVerify.js';

const { findEmptyDialogueIssues, mergeVerifyIssues } = __testing;

describe('scriptVerify deterministic checks', () => {
  it('flags an empty quoted dialogue line with page and panel location', () => {
    const script = [
      '## Page 17',
      '',
      'Panel 4',
      'Description: ASTER-9 CHANDELIER hangs motionless above the room.',
      'Caption: (none)',
      'Dialogue:',
      '- ASTER-9 CHANDELIER: ""',
      'SFX: (none)',
    ].join('\n');

    expect(findEmptyDialogueIssues(script)).toEqual([
      expect.objectContaining({
        severity: 'high',
        location: 'page 17 / panel 4',
        problem: expect.stringContaining('ASTER-9 CHANDELIER is given an empty quoted line'),
        suggestion: expect.stringContaining('Delete the empty dialogue line'),
      }),
    ]);
  });

  it('flags inline empty dialogue values on the Dialogue field', () => {
    const script = [
      '## Page 1',
      '### Panel 2',
      'Description: A face in close-up.',
      '**Dialogue:** KESSA: "   "',
    ].join('\n');

    expect(findEmptyDialogueIssues(script)).toHaveLength(1);
    expect(findEmptyDialogueIssues(script)[0]).toMatchObject({
      location: 'page 1 / panel 2',
    });
  });

  it('ignores non-empty dialogue and dedupes merged findings', () => {
    const script = [
      '## Page 1',
      'Panel 1',
      'Description: A face in close-up.',
      'Dialogue:',
      '- KESSA: "No."',
    ].join('\n');
    const existing = [{
      severity: 'high',
      location: 'page 1 / panel 1',
      problem: 'same',
      suggestion: 'same',
    }];

    expect(findEmptyDialogueIssues(script)).toEqual([]);
    expect(mergeVerifyIssues(existing, existing)).toEqual(existing);
  });
});

import { describe, it, expect } from 'vitest';
import { buildArtReviewPrompt, parseOrchestratorVerdict } from './orchestratorReview.js';

// The verdict parser is the boundary between free model prose and what an
// orchestrated run applies to the project, so its refusals are pinned here.
describe('parseOrchestratorVerdict', () => {
  it('reads the JSON verdict out of surrounding prose and clamps the score', () => {
    const text = 'Sure! My review:\n```json\n{"verdict":"Revise","score":14,"notes":"Hook is buried.","lyrics":"[Chorus]\\nla la"}\n```';
    expect(parseOrchestratorVerdict(text, 'lyrics')).toEqual({ verdict: 'revise', score: 10, notes: 'Hook is buried.', lyrics: '[Chorus]\nla la' });
  });

  it('refuses an answer with no verdict the checkpoint accepts', () => {
    expect(() => parseOrchestratorVerdict('Looks great to me.', 'lyrics')).toThrow(expect.objectContaining({ code: 'ORCHESTRATOR_BAD_VERDICT' }));
    // Only the song may be retaken; a retake of the storyboard is not a verdict it can act on.
    expect(() => parseOrchestratorVerdict('{"verdict":"retake"}', 'storyboard')).toThrow(expect.objectContaining({ code: 'ORCHESTRATOR_BAD_VERDICT' }));
    expect(parseOrchestratorVerdict('{"verdict":"retake"}', 'song')).toMatchObject({ verdict: 'retake' });
  });

  it('keeps only revisions it can apply: known art fields and storyboard notes that name a shot', () => {
    expect(parseOrchestratorVerdict(JSON.stringify({ verdict: 'revise', changes: [
      { field: 'cast', text: 'A paper dancer' }, { field: 'guideArtifactId', text: 'evil' }, { field: 'environments', text: '' },
    ] }), 'art').changes).toEqual([{ field: 'cast', text: 'A paper dancer' }]);
    expect(parseOrchestratorVerdict(JSON.stringify({ verdict: 'approve', changes: [{ text: 'no shot' }, { sceneId: 's1', text: 'Tighter' }],
      fill: [{ sceneId: 's1', camera: 'Push-in', bogus: 'x' }] }), 'storyboard'))
      .toMatchObject({ changes: [{ sceneId: 's1', text: 'Tighter' }], fill: [{ sceneId: 's1', camera: 'Push-in' }] });
  });
});

// After a text revision the guide sheet is not redrawn, so a re-review must not
// keep asking the text to match a sheet drawn from the earlier text.
describe('buildArtReviewPrompt', () => {
  it('tells a re-review that the sheet predates its text revisions', () => {
    const base = { prompt: 'p', concept: {}, draft: { cast: 'A dancer' }, hasImage: true };
    expect(buildArtReviewPrompt(base)).toContain('does the sheet match the text');
    const again = buildArtReviewPrompt({ ...base, sheetPredatesEdits: true });
    expect(again).toContain('drawn before your earlier text revisions');
    expect(again).not.toContain('does the sheet match the text');
  });
});

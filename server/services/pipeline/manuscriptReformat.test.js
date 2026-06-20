import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

// Mock the staged-LLM runner so the reformat core is tested without a real call.
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  resolveStageContext: vi.fn(async () => ({ contextWindow: 100000 })),
}));

import { reformatManuscriptText, reformatManuscriptStageText } from './manuscriptFix.js';
import { runStagedLLM } from '../../lib/stageRunner.js';

describe('reformatManuscriptText — integrity guard', () => {
  beforeEach(() => runStagedLLM.mockReset());

  it('returns the cleaned text when only whitespace/line-breaks changed', async () => {
    runStagedLLM.mockResolvedValue({ content: 'The dawn cycle hums to life.', runId: 'r1' });
    const r = await reformatManuscriptText('The dawn cycle\nhums to life.', { stageId: 'prose' });
    expect(r.text).toBe('The dawn cycle hums to life.');
    expect(r.changed).toBe(true);
    expect(r.runId).toBe('r1');
  });

  it('preserves a de-hyphenated word (skeleton ignores the hyphen)', async () => {
    runStagedLLM.mockResolvedValue({ content: 'something approximating daylight.', runId: 'r1' });
    const r = await reformatManuscriptText('something approxi-\nmating daylight.', { stageId: 'prose' });
    expect(r.text).toBe('something approximating daylight.');
  });

  it('rejects a result that rewrote a word', async () => {
    runStagedLLM.mockResolvedValue({ content: 'The dusk cycle hums to life.', runId: 'r1' });
    await expect(reformatManuscriptText('The dawn cycle\nhums to life.', { stageId: 'prose' }))
      .rejects.toThrow(/changed the wording/i);
  });

  it('rejects an inserted sentence', async () => {
    runStagedLLM.mockResolvedValue({ content: 'The dawn cycle hums to life. Also it rained.', runId: 'r1' });
    await expect(reformatManuscriptText('The dawn cycle\nhums to life.', { stageId: 'prose' }))
      .rejects.toThrow(/changed the wording/i);
  });

  it('removes a duplicated quotation MARK (punctuation) — skeleton unchanged', async () => {
    runStagedLLM.mockResolvedValue({ content: 'He said "hello" to her.', runId: 'r1' });
    const r = await reformatManuscriptText('He said ""hello" to her.', { stageId: 'prose' });
    expect(r.text).toBe('He said "hello" to her.');
  });

  it('rejects deleting a duplicated WORD fragment (exact skeleton required)', async () => {
    // The export duplicated "I"; the guard forbids dropping the letter — the
    // deterministic Format button owns that dedup, the AI pass changes no letter.
    runStagedLLM.mockResolvedValue({ content: '"I need a partner."', runId: 'r1' });
    await expect(reformatManuscriptText('"I\n"I need a partner."', { stageId: 'prose' }))
      .rejects.toThrow(/changed the wording/i);
  });

  it('rejects dropping a short word that inverts meaning (do not go → do go)', async () => {
    runStagedLLM.mockResolvedValue({ content: 'Please do go now.', runId: 'r1' });
    await expect(reformatManuscriptText('Please do not\ngo now.', { stageId: 'prose' }))
      .rejects.toThrow(/changed the wording/i);
  });

  it('rejects a case-only rewrite (the skeleton is case-sensitive)', async () => {
    runStagedLLM.mockResolvedValue({ content: 'the us economy.', runId: 'r1' });
    await expect(reformatManuscriptText('the US\neconomy.', { stageId: 'prose' }))
      .rejects.toThrow(/changed the wording/i);
  });

  it('rejects a mangled contraction (apostrophe dropped: don\'t → dont)', async () => {
    runStagedLLM.mockResolvedValue({ content: 'I dont know.', runId: 'r1' });
    await expect(reformatManuscriptText("I don't\nknow.", { stageId: 'prose' }))
      .rejects.toThrow(/changed the wording/i);
  });

  it('accepts a benign smart-quote apostrophe normalization', async () => {
    // curly ’ ↔ straight ' is normalized in the skeleton, so it is not flagged.
    runStagedLLM.mockResolvedValue({ content: 'I don’t know.', runId: 'r1' });
    const r = await reformatManuscriptText("I don't\nknow.", { stageId: 'prose' });
    expect(r.text).toBe('I don’t know.');
  });

  it('rejects a dropped clause', async () => {
    const input = 'The pool hums softly. The nebula churns in slow motion outside the wide viewport.';
    runStagedLLM.mockResolvedValue({ content: 'The pool hums softly.', runId: 'r1' });
    await expect(reformatManuscriptText(input, { stageId: 'prose' }))
      .rejects.toThrow(/changed the wording/i);
  });

  it('strips a stray code fence the model wrapped the output in', async () => {
    runStagedLLM.mockResolvedValue({ content: '```\nThe dawn cycle hums.\n```', runId: 'r1' });
    const r = await reformatManuscriptText('The dawn cycle\nhums.', { stageId: 'prose' });
    expect(r.text).toBe('The dawn cycle hums.');
  });

  it('strips echoed ===MANUSCRIPT=== markers', async () => {
    runStagedLLM.mockResolvedValue({ content: '===MANUSCRIPT===\nThe dawn cycle hums.\n===MANUSCRIPT===', runId: 'r1' });
    const r = await reformatManuscriptText('The dawn cycle\nhums.', { stageId: 'prose' });
    expect(r.text).toBe('The dawn cycle hums.');
  });

  it('no-ops on empty/whitespace input without calling the model', async () => {
    const r = await reformatManuscriptText('   ', { stageId: 'prose' });
    expect(r.changed).toBe(false);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('passes the stage format label and source through to the runner', async () => {
    runStagedLLM.mockResolvedValue({ content: 'Panel 1. A wide shot.', runId: 'r1' });
    await reformatManuscriptText('Panel 1. A wide shot.', { stageId: 'comicScript', providerOverride: 'p1', modelOverride: 'm1' });
    expect(runStagedLLM).toHaveBeenCalledWith(
      'manuscript-reformat',
      expect.objectContaining({ format: 'Comic script', body: 'Panel 1. A wide shot.' }),
      expect.objectContaining({ providerOverride: 'p1', modelOverride: 'm1', returnsJson: false }),
    );
  });
});

describe('reformatManuscriptStageText — endpoint wrapper', () => {
  beforeEach(() => runStagedLLM.mockReset());

  it('rejects a non-manuscript stage', async () => {
    await expect(reformatManuscriptStageText('hi', { stageId: 'idea' }))
      .rejects.toThrow(/not an editable manuscript stage/i);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('rejects empty content without calling the model', async () => {
    await expect(reformatManuscriptStageText('   ', { stageId: 'prose' }))
      .rejects.toThrow(/no drafted text/i);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('returns the computed result for a valid stage (no persistence)', async () => {
    runStagedLLM.mockResolvedValue({ content: 'The dawn cycle hums.', runId: 'r1' });
    const r = await reformatManuscriptStageText('The dawn cycle\nhums.', { stageId: 'prose' });
    expect(r).toEqual({ text: 'The dawn cycle hums.', runId: 'r1', changed: true });
  });
});

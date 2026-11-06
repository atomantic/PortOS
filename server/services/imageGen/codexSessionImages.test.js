import { describe, it, expect } from 'vitest';
import { parseSessionImageRecords, selectJobImage } from './codexSessionImages.js';

const JOB_PROMPT = 'A red fox crossing a snowy bridge at dusk';
const record = (fileName, prompt) => ({ fileName, prompt, result: null });
const select = (records, jobPrompt = JOB_PROMPT) => selectJobImage({
  fileNames: records.map(({ fileName }) => fileName), records, jobPrompt,
});

describe('selectJobImage', () => {
  it.each([
    ['a rewrite over an unrelated call', [record('a.png', `${JOB_PROMPT}, cinematic light`), record('b.png', 'completion_summary')], 'a.png'],
    ['the verbatim prompt over a close rewrite', [record('a.png', `${JOB_PROMPT}, cinematic`), record('b.png', `  ${JOB_PROMPT}\n`)], 'b.png'],
    ['the later image of an identical retry', [record('a.png', `${JOB_PROMPT}, cinematic`), record('b.png', `${JOB_PROMPT}, cinematic`)], 'b.png'],
    ['the later image of a retry differing only in punctuation', [record('a.png', `${JOB_PROMPT}, cinematic`), record('b.png', `${JOB_PROMPT} cinematic.`)], 'b.png'],
    ['a verbatim short prompt whose words are all too short to count', [record('a.png', 'go up'), record('b.png', 'completion_summary')], 'a.png', 'Go up!'],
  ])('prefers %s', (_label, records, fileName, jobPrompt) => {
    expect(select(records, jobPrompt)).toMatchObject({ fileName, ignoredImages: 1 });
  });

  it.each([
    ['two different rewrites', [record('a.png', `${JOB_PROMPT}, cinematic`), record('b.png', `${JOB_PROMPT}, watercolor`)], JOB_PROMPT],
    ['only unrelated calls', [record('a.png', 'completion_summary'), record('b.png', 'progress dashboard')], JOB_PROMPT],
    ['a call sharing only short words with the job and an unrelated one', [record('a.png', 'a dashboard on an at to of'), record('b.png', 'completion_summary')], 'A fox on a log at an inn'],
    ['several images and an attachment-only job with no prompt', [record('a.png', 'edit the image'), record('b.png', 'edit the image')], ''],
  ])('refuses to guess between %s', (_label, records, jobPrompt) => {
    expect(select(records, jobPrompt)).toEqual({ unmatchedImages: 2 });
  });

  it('keeps a lone image whatever its prompt says, since Codex may rewrite it entirely', () => {
    expect(select([record('a.png', 'completion_summary')])).toMatchObject({ fileName: 'a.png', ignoredImages: 0 });
  });

  it('ignores a file no log entry claims once another image matches', () => {
    expect(selectJobImage({
      fileNames: ['stray.png', 'real.png'], records: [record('real.png', JOB_PROMPT)], jobPrompt: JOB_PROMPT,
    })).toMatchObject({ fileName: 'real.png', ignoredImages: 1 });
  });

  it('does not count a log entry whose bytes and file are both missing or not a PNG', () => {
    const notPng = Buffer.from('this is not a png file').toString('base64');
    expect(selectJobImage({
      fileNames: ['real.png'],
      records: [record('real.png', 'completion_summary'), { fileName: null, prompt: JOB_PROMPT, result: notPng }, record('gone.png', JOB_PROMPT)],
      jobPrompt: JOB_PROMPT,
    })).toMatchObject({ fileName: 'real.png', ignoredImages: 0 });
  });
});

describe('parseSessionImageRecords', () => {
  it('reads current and older event shapes and skips everything else', () => {
    const lines = [
      JSON.stringify({ payload: { type: 'image_generation_end', revised_prompt: 'older', result: 'b64' } }),
      '{"truncated":',
      JSON.stringify({ payload: { type: 'item_completed', item: { kind: 'image_gen.generation', revisedPrompt: 'current', savedPath: '/somewhere/else/exec-a.png' } } }),
      JSON.stringify({ payload: { type: 'item_completed', item: { kind: 'other.extension', revisedPrompt: 'not an image' } } }),
      '',
    ];
    expect(parseSessionImageRecords(lines.join('\n'))).toEqual([
      { prompt: 'older', fileName: null, result: 'b64' },
      { prompt: 'current', fileName: 'exec-a.png', result: null },
    ]);
  });
});

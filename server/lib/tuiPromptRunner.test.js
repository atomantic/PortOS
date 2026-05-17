import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanTuiResponse, resolveTuiResponseText } from './tuiPromptRunner.js';

// Targeted coverage for the cleanTuiResponse helper — it shapes what every
// TUI-provider caller sees as the model response (paste-marker removal,
// prompt-echo strip). Bugs here would silently corrupt prose generation
// and JSON parsing downstream.

describe('cleanTuiResponse', () => {
  describe('empty / non-string inputs', () => {
    it('returns empty string for empty input', () => {
      expect(cleanTuiResponse('', 'anything')).toBe('');
    });
    it('returns empty string for non-string raw', () => {
      expect(cleanTuiResponse(null, 'anything')).toBe('');
      expect(cleanTuiResponse(undefined, 'anything')).toBe('');
      expect(cleanTuiResponse(42, 'anything')).toBe('');
    });
  });

  describe('paste-marker removal', () => {
    it('drops the Claude Code [Pasted text #N +M lines] marker', () => {
      const raw = 'before\n[Pasted text #1 +42 lines]\nresponse body';
      expect(cleanTuiResponse(raw, '')).toBe('before\n\nresponse body');
    });

    it('drops multiple paste markers from the same buffer', () => {
      const raw = '[Pasted text #1 +3 lines] reply A [Pasted text #2 +5 lines] reply B';
      expect(cleanTuiResponse(raw, '')).toBe('reply A  reply B');
    });

    it('leaves text that resembles but does not match the marker pattern alone', () => {
      const raw = 'Look at [Pasted text without number] and continue';
      expect(cleanTuiResponse(raw, '')).toBe('Look at [Pasted text without number] and continue');
    });
  });

  describe('prompt echo elision', () => {
    it('strips a verbatim prompt that the TUI echoes back', () => {
      const prompt = 'Write a sonnet about an ocelot wearing a crown of starlight';
      const raw = `${prompt}\n\nShall I compare thee to a summer's ocelot?`;
      expect(cleanTuiResponse(raw, prompt)).toBe(`Shall I compare thee to a summer's ocelot?`);
    });

    it('strips every echoed occurrence (some TUIs render the prompt twice)', () => {
      const prompt = 'Generate a six-word science fiction story about regret';
      const raw = `${prompt}\nresponse 1\n${prompt}\nresponse 2`;
      const out = cleanTuiResponse(raw, prompt);
      expect(out).not.toContain(prompt);
      expect(out).toContain('response 1');
      expect(out).toContain('response 2');
    });

    it('skips prompt-echo elision when the prompt is shorter than the 16-char guard', () => {
      // Short prompts could appear naturally inside the model's response
      // (e.g. prompt="ok" appearing in "okay, here is..."). The guard
      // keeps the response intact instead of mass-deleting bigrams.
      const prompt = 'Write?';
      const raw = `Write? Sure, here is my best Writeful Writeup`;
      expect(cleanTuiResponse(raw, prompt)).toBe(raw);
    });

    it('does NOT strip prompt-substring matches inside the response — only exact full-prompt matches', () => {
      // split-join uses the full prompt as the splitter, so a substring
      // of the prompt that appears in the model's reply survives. This
      // is the right behavior: a model often refers back to phrases
      // from the prompt without echoing the whole thing.
      const prompt = 'Continue the story: The cat sat on the mat';
      const raw = `${prompt}\nThe cat sat on the mat for many hours.`;
      const out = cleanTuiResponse(raw, prompt);
      // First occurrence (the full prompt echo) elided; the substring
      // reference in the reply is preserved.
      expect(out).toBe('The cat sat on the mat for many hours.');
    });

    it('handles undefined/non-string prompt without throwing', () => {
      expect(cleanTuiResponse('plain response', undefined)).toBe('plain response');
      expect(cleanTuiResponse('plain response', null)).toBe('plain response');
      expect(cleanTuiResponse('plain response', 12345)).toBe('plain response');
    });
  });

  describe('integration — marker + prompt + trim together', () => {
    it('removes paste marker AND prompt echo AND trims surrounding whitespace', () => {
      const prompt = 'Summarize the plot of Aster of Pan in a single sentence';
      const raw = `\n\n[Pasted text #7 +1 lines]\n${prompt}\n\nA child rebuilds wonder in a green ruin.\n\n`;
      expect(cleanTuiResponse(raw, prompt)).toBe('A child rebuilds wonder in a green ruin.');
    });
  });
});

// resolveTuiResponseText is the file-or-fallback chooser called from
// executeTuiRun.finish. The PTY path is irreplicable in a unit test, so the
// helper was extracted to make this decision (which is the actual new
// behavior of the PR) testable in isolation.

describe('resolveTuiResponseText', () => {
  let tmpDir;
  let responseFilePath;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tui-response-test-'));
    responseFilePath = join(tmpDir, 'tui-response.txt');
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => null);
  });

  it('returns the response file contents trimmed and flags usedResponseFile=true on success', async () => {
    await writeFile(responseFilePath, '\n  the prose body  \n');
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath,
      outputBuffer: 'screen chrome',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'the prose body', usedResponseFile: true });
  });

  it('falls back to cleanTuiResponse(outputBuffer) when the file does not exist', async () => {
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath: join(tmpDir, 'does-not-exist.txt'),
      outputBuffer: '[Pasted text #1 +0 lines]\nfallback body',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'fallback body', usedResponseFile: false });
  });

  it('falls back to cleanTuiResponse when the file exists but is empty', async () => {
    await writeFile(responseFilePath, '');
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath,
      outputBuffer: 'fallback body',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'fallback body', usedResponseFile: false });
  });

  it('falls back to cleanTuiResponse when the file is whitespace-only', async () => {
    await writeFile(responseFilePath, '   \n\t  \n');
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath,
      outputBuffer: 'fallback body',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'fallback body', usedResponseFile: false });
  });

  it('does NOT read the file when success=false — falls back unconditionally', async () => {
    // A failed run shouldn't trust a partial file the model may have started
    // writing. Even if the file exists with usable content, the caller
    // rejects with an error and the response text path doesn't matter much
    // — but the contract is: success=false ⇒ usedResponseFile=false.
    await writeFile(responseFilePath, 'partial response that should not be used');
    const out = await resolveTuiResponseText({
      success: false,
      responseFilePath,
      outputBuffer: 'partial screen scrape',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'partial screen scrape', usedResponseFile: false });
  });

  it('passes wrappedPrompt into cleanTuiResponse on the fallback path so prompt-echo elision strips the directive-wrapped prompt', async () => {
    const wrappedPrompt = 'WRITE TO FILE INSTRUCTIONS AND TASK BODY — a long enough string to clear the 16-char guard';
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath: join(tmpDir, 'absent.txt'),
      outputBuffer: `${wrappedPrompt}\nthe model reply`,
      wrappedPrompt,
    });
    expect(out).toEqual({ text: 'the model reply', usedResponseFile: false });
  });
});

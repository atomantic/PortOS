import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../lib/fileCore.js', async () => ({ ...(await vi.importActual('../../lib/fileCore.js')), sleep: vi.fn(async () => {}) }));

const { renderOnGeminiWeb } = await import('./geminiWebDriver.js');

// Just enough of a Playwright page to stand in for the Gemini composer. Each test
// scripts what the app shows: the consent dialog, and the chat's answers in order.
function fakeGemini({ consent = false, url = 'https://gemini.google.com/app', answers = [], video = { status: 200, type: 'video/mp4' } } = {}) {
  const log = { clicks: [], files: null, typed: '', closed: false, front: 0 };
  let chooserResolve;
  const chooserEvent = new Promise((resolve) => { chooserResolve = resolve; });
  const control = (name) => ({
    filter: () => control(name),
    waitFor: async () => {
      if (name === 'dialog' && !consent) await new Promise(() => {});
    },
    count: async () => 0,
    getAttribute: async (attr) => (attr === 'aria-label' ? 'Aspect ratio, Landscape (16:9)' : 'false'),
    click: async () => {
      log.clicks.push(name);
      if (name === 'uploader' && !consent) chooserResolve({ setFiles: async (files) => { log.files = files; } });
    },
  });
  const page = {
    goto: async () => {},
    url: () => url,
    getByRole: (role, { name } = {}) => control(role === 'dialog' ? 'dialog' : String(name)),
    locator: () => control('uploader'),
    waitForEvent: () => chooserEvent,
    keyboard: { insertText: async (text) => { log.typed = text; } },
    evaluate: async () => answers.shift() ?? { responded: false },
    bringToFront: async () => { log.front += 1; },
    close: async () => { log.closed = true; },
  };
  const context = {
    newPage: async () => page,
    request: { get: async () => ({
      ok: () => video.status === 200, status: () => video.status, headers: () => ({ 'content-type': video.type }), body: async () => Buffer.from('clip-bytes'),
    }) },
  };
  return { log, connect: async () => ({ browser: { close: async () => {} }, context }) };
}

const sends = (log) => log.clicks.filter((name) => name === 'Send message').length;
const CLIP = { responded: true, videoUrl: 'https://example.test/clip', text: 'Your video is ready!', finished: true };

let outputDir;
let outputPath;
beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'portos-gemini-driver-'));
  outputPath = join(outputDir, 'out.mp4');
});
afterEach(() => rm(outputDir, { recursive: true, force: true }));

const render = (fake, extra = {}) => renderOnGeminiWeb({
  prompt: 'she rides past', files: ['/example/frame.png', '/example/sheet.png'], aspectChoice: 'Landscape (16:9)',
  outputPath, deadline: Date.now() + 60_000, connect: fake.connect, ...extra,
});

describe('renderOnGeminiWeb', () => {
  it('attaches, sends once, waits through the holding answer, and saves the clip', async () => {
    const fake = fakeGemini({ answers: [
      { responded: false },
      { responded: true, videoUrl: null, text: 'Generating your video. This could take a few minutes.', finished: false },
      CLIP,
    ] });
    const phases = [];
    await render(fake, { onPhase: (phase) => phases.push(phase) });
    expect(fake.log.files).toEqual(['/example/frame.png', '/example/sheet.png']);
    expect(fake.log.typed).toBe('she rides past');
    expect(sends(fake.log)).toBe(1);
    expect(await readFile(outputPath, 'utf8')).toBe('clip-bytes');
    expect(phases.slice(0, 3)).toEqual(['open', 'attach', 'send']);
    expect(phases.at(-1)).toBe('fetch');
    expect(fake.log.closed).toBe(true);
  });

  it('stops at the upload terms without agreeing, sending or closing the tab', async () => {
    const fake = fakeGemini({ consent: true });
    await expect(render(fake)).rejects.toMatchObject({ code: 'GEMINI_WEB_CONSENT_REQUIRED' });
    expect(fake.log.clicks).not.toContain('Agree');
    expect(sends(fake.log)).toBe(0);
    expect(fake.log.closed).toBe(false);
  });

  it('asks for a sign-in when Google redirects to its login page', async () => {
    const fake = fakeGemini({ url: 'https://accounts.google.com/signin' });
    await expect(render(fake)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
    expect(fake.log.closed).toBe(false);
  });

  it("reports Gemini's refusal in its own words and never sends again", async () => {
    const fake = fakeGemini({ answers: [{ responded: true, videoUrl: null, text: "You've reached your video limit for today.", finished: true }] });
    await expect(render(fake)).rejects.toMatchObject({ code: 'GEMINI_WEB_REFUSED', message: expect.stringContaining('video limit') });
    expect(sends(fake.log)).toBe(1);
  });

  it('keeps the chat open when the deadline passes after sending', async () => {
    const fake = fakeGemini();
    await expect(render(fake, { deadline: Date.now() - 1 })).rejects.toMatchObject({ code: 'GEMINI_WEB_TIMEOUT' });
    expect(sends(fake.log)).toBe(1);
    expect(fake.log.closed).toBe(false);
  });

  it('refuses a download that is not a video', async () => {
    const fake = fakeGemini({ answers: [CLIP], video: { status: 200, type: 'text/html' } });
    await expect(render(fake)).rejects.toMatchObject({ code: 'GEMINI_WEB_DOWNLOAD_FAILED' });
    expect(fake.log.closed).toBe(false);
  });
});

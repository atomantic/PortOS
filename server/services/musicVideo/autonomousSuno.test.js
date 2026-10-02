/**
 * The Suno step with a fake browser page and a fake CDN. Pins what only this
 * layer knows: a signed-out page is a login-required park (not a generic
 * failure), songs already in the workspace are never mistaken for ours, audio
 * is accepted only once it stops growing, and a retry reuses submitted songs.
 */

import { describe, it, expect, vi } from 'vitest';
import { __testing, generateSunoSong } from './autonomousSuno.js';

const { downloadSunoAudio, submitSunoSong } = __testing;

const OLD = '11111111-1111-1111-1111-111111111111';
const NEW_A = '22222222-2222-2222-2222-222222222222';
const NEW_B = '33333333-3333-3333-3333-333333333333';
const noSleep = async () => {};

/** A just-enough Playwright page: tracks fills/clicks and exposes song links that appear after Create. */
function fakePage({ url = 'https://suno.com/create', hasForm = true, modern = true, afterCreate = [NEW_A, NEW_B] } = {}) {
  const fills = {};
  let created = false;
  const locator = (selector) => {
    const handle = {
      count: async () => selector === 'textarea' ? (hasForm ? 1 : 0) : selector === '[role="textbox"][aria-label="Lyrics editor"]' ? (modern ? 1 : 0) : 1,
      waitFor: async () => {},
      fill: async (v) => { fills[selector] = v; },
      click: async () => {},
    };
    return { ...handle, first: () => handle };
  };
  const button = (role, options) => ({
    count: async () => role === 'textbox' || role === 'tab' ? (modern ? 1 : 0) : /instrumental|custom/.test(String(options.name)) ? (modern ? 0 : 1) : 1,
    first: () => ({ click: async () => {}, fill: async v => { fills[options.name] = v; } }),
    last: () => ({ click: async () => { created = true; } }),
  });
  return {
    fills,
    goto: vi.fn(async () => {}),
    url: () => url,
    locator,
    getByRole: button,
    evaluate: async () => [`/song/${OLD}`, ...(created ? afterCreate.map((id) => `/song/${id}`) : [])],
    close: async () => {},
  };
}

describe('submitSunoSong', () => {
  const fields = { title: 'Neon Rain', style: 'synthwave', lyrics: '[verse]\nrain', instrumental: false };

  it('fills the custom form and returns only the songs that appeared after Create', async () => {
    const page = fakePage();
    const ids = await submitSunoSong(page, fields, { sleep: noSleep });
    expect(ids).toEqual([NEW_A, NEW_B]);
    expect(page.fills['[role="textbox"][aria-label="Lyrics editor"],textarea[placeholder*="lyrics" i]']).toBe('[verse]\nrain');
    expect(page.fills['textarea:not([aria-label]):not([placeholder="Describe the sound you want"])']).toBe('synthwave');
    expect(page.fills['input[placeholder*="title" i]:visible']).toBe('Neon Rain');
  });

  it('leaves the lyrics empty for an instrumental song', async () => {
    const page = fakePage();
    await submitSunoSong(page, { ...fields, instrumental: true, lyrics: '' }, { sleep: noSleep });
    expect(page.fills['[role="textbox"][aria-label="Lyrics editor"],textarea[placeholder*="lyrics" i]']).toBe('');
  });

  it('keeps the older Custom form compatible', async () => {
    const page = fakePage({ modern: false });
    await submitSunoSong(page, fields, { sleep: noSleep });
    expect(page.fills['[role="textbox"][aria-label="Lyrics editor"],textarea[placeholder*="lyrics" i]']).toBe(fields.lyrics);
    expect(page.fills['textarea[placeholder*="style" i]']).toBe(fields.style);
  });

  it('reports a signed-out page as login-required so the run parks for the operator', async () => {
    await expect(submitSunoSong(fakePage({ hasForm: false }), fields, { sleep: noSleep })).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
    await expect(submitSunoSong(fakePage({ url: 'https://accounts.suno.com/sign-in' }), fields, { sleep: noSleep })).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });
});

describe('downloadSunoAudio', () => {
  const body = (size) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(size) });

  it('waits out a partial file: returns only once the size is stable and real', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(body(1000)) // too small — a stub
      .mockResolvedValueOnce(body(300 * 1024)) // growing
      .mockResolvedValueOnce(body(400 * 1024))
      .mockResolvedValueOnce(body(400 * 1024)); // stable
    const bytes = await downloadSunoAudio(NEW_A, { fetchImpl, sleep: noSleep, now: () => 0 });
    expect(bytes.length).toBe(400 * 1024);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl).toHaveBeenCalledWith(`https://cdn1.suno.ai/${NEW_A}.mp3`);
  });

  it('gives up with a clear timeout naming the song when it never finishes', async () => {
    let t = 0;
    await expect(downloadSunoAudio(NEW_A, {
      fetchImpl: async () => ({ ok: false }), sleep: noSleep, intervalMs: 10, timeoutMs: 25, now: () => (t += 10),
    })).rejects.toMatchObject({ code: 'SUNO_AUDIO_TIMEOUT', context: expect.objectContaining({ songId: NEW_A }) });
  });
});

describe('generateSunoSong', () => {
  const fields = { title: 't', style: 's', lyrics: 'l', instrumental: false };
  const audio = { ok: true, arrayBuffer: async () => new ArrayBuffer(200 * 1024) };
  const connect = async () => ({ browser: { close: async () => {} }, context: { newPage: async () => fakePage() } });

  it('submits once, downloads the first take and imports it', async () => {
    const importAudio = vi.fn(async () => ({ filename: 'music-x.mp3', sizeBytes: 204800 }));
    const onSubmitted = vi.fn();
    const out = await generateSunoSong(fields, { connect, importAudio, onSubmitted, fetchImpl: async () => audio, sleep: noSleep, intervalMs: 0 });
    expect(out).toMatchObject({ songId: NEW_A, songIds: [NEW_A, NEW_B], filename: 'music-x.mp3' });
    expect(onSubmitted).toHaveBeenCalledWith([NEW_A, NEW_B]);
  });

  it('with songs already submitted, never opens the browser — a retry spends no new credits', async () => {
    const connectSpy = vi.fn(connect);
    const out = await generateSunoSong(fields, {
      connect: connectSpy, importAudio: async () => ({ filename: 'm.mp3', sizeBytes: 1 }), songIds: [NEW_B],
      fetchImpl: async () => audio, sleep: noSleep, intervalMs: 0,
    });
    expect(connectSpy).not.toHaveBeenCalled();
    expect(out.songId).toBe(NEW_B);
  });
});

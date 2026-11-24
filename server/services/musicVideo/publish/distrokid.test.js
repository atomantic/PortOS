/**
 * DistroKid adapter: login detection, the single-artist refusal, paid-extra
 * untick reporting, the three-step AI disclosure, and the agreement/Upload
 * boundary the director keeps. Driven by a fake page, no Chromium.
 */
import { describe, expect, it } from 'vitest';
import { distrokidAdapter } from './distrokid.js';
import { discloseDistrokidAi, fillDistrokidFields, setDistrokidArtist, untickDistrokidExtras } from '../../../lib/distrokidForm.js';

function fakePage({
  url = 'https://distrokid.com/new/',
  hasForm = true,
  artist = { ok: true, fixed: null },
  extras = { stillTicked: [], unticked: [] },
  extrasThrows = false,
  disclosure = { gate: true, parts: true, check: true },
  fields = { done: [], missed: [] },
  checkThrows = false,
} = {}) {
  const log = [];
  const element = (sel) => {
    const el = {
      first: () => el,
      count: async () => (/artistName/.test(sel) && !hasForm ? 0 : 1),
      setInputFiles: async (path) => { log.push(['setFiles', sel, path]); },
      check: async () => {
        log.push(['check', sel]);
        if (checkThrows) throw new Error('timeout');
      },
      click: async () => { log.push(['click', sel]); },
    };
    return el;
  };
  return {
    log,
    url: () => url,
    goto: async (to) => { log.push(['goto', to]); },
    waitForTimeout: async () => {},
    locator: (sel) => element(sel),
    evaluate: async (fn, arg) => {
      if (fn === setDistrokidArtist) return artist;
      if (fn === fillDistrokidFields) return fields;
      if (fn === discloseDistrokidAi) { log.push(['ai', arg.step]); return disclosure[arg.step]; }
      if (fn === untickDistrokidExtras) {
        if (extrasThrows) throw new Error('page closed');
        return extras;
      }
      if (Array.isArray(arg)) { log.push(['set', arg[0], arg[1]]); return true; }
      return undefined;
    },
    waitForFunction: async () => {},
  };
}

const payload = {
  artist: 'Example Artist',
  title: 'Example Song',
  cover: { path: '/media/cover.png' },
  audio: { path: '/media/song.wav' },
  songwriter: { first: 'Sam', last: 'Writer' },
  songwriterRole: 'both',
  explicit: false,
  language: 'English',
  genre: 'Pop',
  newArtistProfile: true,
  credits: { performer: 'Performer', producer: 'Producer' },
  ai: { lyrics: false, music: false, vocals: false },
};

describe('DistroKid adapter', () => {
  it('asks for sign-in when redirected to login or when the upload form is absent', async () => {
    await expect(distrokidAdapter.prepare(fakePage({ url: 'https://distrokid.com/signin/' }), payload))
      .rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
    await expect(distrokidAdapter.prepare(fakePage({ hasForm: false }), payload))
      .rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
  });

  it('refuses to fill a single-artist account that releases under a different name', async () => {
    const page = fakePage({ artist: { ok: false, fixed: 'Someone Else' } });
    await expect(distrokidAdapter.prepare(page, payload)).rejects.toThrow(/releases as "Someone Else", not "Example Artist"/);
    expect(page.log.some(([kind]) => kind === 'setFiles')).toBe(false);
  });

  it('refuses when no artist field accepts the name', async () => {
    const page = fakePage({ artist: { ok: false, fixed: null } });
    await expect(distrokidAdapter.prepare(page, payload)).rejects.toThrow(/no artist field accepted "Example Artist"/);
  });

  it('reports the artist DistroKid fixed for a matching single-artist account', async () => {
    const summary = await distrokidAdapter.prepare(fakePage({ artist: { ok: true, fixed: 'Example Artist (fixed)' } }), payload);
    expect(summary.artist).toBe('Example Artist (fixed)');
  });

  it('lists paid extras that are still ticked and withholds the all-clear', async () => {
    const summary = await distrokidAdapter.prepare(fakePage({ extras: { stillTicked: ['Shazam', 'Leave a Legacy'], unticked: [] } }), payload);
    expect(summary.leftForYou).toContain('untick the paid extras: Shazam, Leave a Legacy');
    expect(summary.paidExtras).toBeNull();
  });

  it('leaves the extras check to the director when the page evaluation fails', async () => {
    const summary = await distrokidAdapter.prepare(fakePage({ extrasThrows: true }), payload);
    expect(summary.leftForYou).toContain('check that no paid extras are ticked');
    expect(summary.paidExtras).toBeNull();
  });

  it('reports unticked extras when every box was cleared', async () => {
    const summary = await distrokidAdapter.prepare(fakePage({ extras: { stillTicked: [], unticked: ['Shazam'] } }), payload);
    expect(summary.paidExtras).toBe('unticked: Shazam');
    expect(summary.leftForYou.join('|')).not.toMatch(/untick the paid extras/);
  });

  it('answers the AI gate, the parts, then re-reads the gate when AI was used', async () => {
    const page = fakePage();
    const summary = await distrokidAdapter.prepare(page, { ...payload, ai: { lyrics: true, music: false, vocals: false } });
    expect(page.log.filter(([kind]) => kind === 'ai').map(([, s]) => s)).toEqual(['gate', 'parts', 'check']);
    expect(summary.ai).toBe('lyrics');
    expect(summary.leftForYou).not.toContain('AI disclosure');
  });

  it('flags the AI disclosure when the re-read shows the answer did not stick', async () => {
    const summary = await distrokidAdapter.prepare(
      fakePage({ disclosure: { gate: true, parts: true, check: false } }),
      { ...payload, ai: { lyrics: false, music: true, vocals: false } },
    );
    expect(summary.leftForYou).toContain('AI disclosure');
  });

  it('answers only the gate when no AI was used', async () => {
    const page = fakePage();
    const summary = await distrokidAdapter.prepare(page, payload);
    expect(page.log.filter(([kind]) => kind === 'ai').map(([, s]) => s)).toEqual(['gate']);
    expect(summary.ai).toBe('None');
  });

  it('reports a soft field miss instead of failing the draft', async () => {
    const summary = await distrokidAdapter.prepare(fakePage({ checkThrows: true }), payload);
    expect(summary.leftForYou).toContain('explicit: no');
  });

  it('never ticks the agreements or presses Upload, and hands both to the director', async () => {
    const page = fakePage();
    const summary = await distrokidAdapter.prepare(page, payload);
    const touched = page.log.filter(([kind]) => kind === 'check' || kind === 'click').map(([, sel]) => sel).join(' ');
    expect(touched).not.toMatch(/agree|upload|submit/i);
    expect(summary.leftForYou).toEqual(expect.arrayContaining(['the agreement checkboxes', 'Upload']));
  });
});

describe('DistroKid findPost', () => {
  const landed = (url, shown = true) => ({
    url: () => url,
    waitForFunction: async () => { if (!shown) throw new Error('timeout'); },
  });

  it('resolves the release dashboard link once it shows the title', async () => {
    const url = 'https://distrokid.com/dashboard/album/?albumuuid=0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    expect(await distrokidAdapter.findPost(landed(url), payload)).toBe(url);
  });

  it('ignores other DistroKid pages and a dashboard that does not show the title', async () => {
    expect(await distrokidAdapter.findPost(landed('https://distrokid.com/new/'), payload)).toBeNull();
    expect(await distrokidAdapter.findPost(landed('https://distrokid.com/dashboard/album/?albumuuid=0a1b'), payload)).toMatch(/albumuuid=0a1b/);
    expect(await distrokidAdapter.findPost(landed('https://distrokid.com/dashboard/album/?albumuuid=0a1b', false), payload)).toBeNull();
  });
});

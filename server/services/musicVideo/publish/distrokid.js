/**
 * DistroKid adapter: the song goes to Spotify (and the other stores DistroKid
 * delivers to) as a single. Spotify has no upload for independent artists, so
 * a distributor is the only route. prepare() fills DistroKid's upload form
 * with the song's audio, a square cover, title, artist, songwriter and role,
 * explicit and instrumental flags, the AI disclosure, genre, language, store
 * profiles, Apple Music credits, the preview start and the release date, and
 * unticks every paid extra. It never ticks the agreement boxes or presses
 * Upload: those attest the director owns the rights, so they stay with the
 * director. Per-track fields carry a random suffix per page load, so they are
 * matched by name prefix.
 *
 * DistroKid restyles this form often, so every field is found by its id or
 * name (the in-page steps live in lib/distrokidForm.js), and a field that is
 * no longer there is reported in the summary as left for the director rather
 * than failing the whole draft.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, step } from './browser.js';
import { discloseDistrokidAi, fillDistrokidFields, setDistrokidArtist, untickDistrokidExtras } from '../../../lib/distrokidForm.js';

const label = 'DistroKid';
const UPLOAD_URL = 'https://distrokid.com/new/';

/** Set a form control's value the way DistroKid's own scripts listen for. */
async function setValue(page, selector, value) {
  return page.evaluate(([sel, val]) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.type !== 'hidden');
    if (!el) return false;
    if (el.tagName === 'SELECT') {
      const want = String(val).toLowerCase();
      const opt = [...el.options].find((o) => o.value === String(val) || o.textContent.trim().toLowerCase() === want);
      if (!opt) return false;
      el.value = opt.value;
    } else {
      el.focus();
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur?.();
    return true;
  }, [selector, value]);
}

const ROLE_TEXT = { music: 'Music', lyrics: 'Lyrics', both: 'Music and lyrics' };
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export const distrokidAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open the upload form', () => page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(4000);
    if (/signin|login/i.test(page.url()) || !(await page.locator('#artistName, [name=bandname]').count())) throw loginRequired(label, UPLOAD_URL);

    const leftForYou = [];
    const soft = async (what, fn) => { if (!(await fn().catch(() => false))) leftForYou.push(what); };

    // The song count rebuilds the form, so it goes first.
    await soft('number of songs (1)', () => setValue(page, '#howManySongsOnThisAlbum, select[name=howmanysongs]', '1'));
    await page.waitForTimeout(1500);
    await step(label, 'set the artist', async () => {
      // An account with one artist fixes it in a hidden field, so it is checked, not typed.
      const { ok, fixed } = await page.evaluate(setDistrokidArtist, payload.artist);
      if (ok) return;
      throw new Error(fixed
        ? `this DistroKid account releases as "${fixed}", not "${payload.artist}"`
        : `no artist field accepted "${payload.artist}"`);
    });
    await step(label, 'upload the cover', () => page.locator('#artwork, input[type=file][name=artwork]').first().setInputFiles(payload.cover.path, { timeout: T }));
    await step(label, 'upload the audio', () => page.locator('#js-track-upload-1').first().setInputFiles(payload.audio.path, { timeout: T }));
    await step(label, 'set the song title', async () => {
      if (!(await setValue(page, 'input[name^="title_"]', payload.title))) throw new Error('no song title field');
    });
    await soft('songwriter', async () => (await setValue(page, 'input[name^="songwriter_real_name_first"]', payload.songwriter.first))
      && setValue(page, 'input[name^="songwriter_real_name_last"]', payload.songwriter.last));
    await soft(payload.explicit ? 'explicit: yes' : 'explicit: no', async () => {
      await page.locator(payload.explicit ? '#js-explicit-radio-button-1' : '#js-not-explicit-radio-button-1').first().check({ timeout: 5000 });
      return true;
    });
    if (payload.releaseDate) await soft(`release date ${payload.releaseDate}`, () => setValue(page, '#release-date-dp, input[name=releaseDate]', payload.releaseDate));
    const fields = await page.evaluate(fillDistrokidFields, {
      albumTitle: payload.title,
      language: payload.language,
      genre: payload.genre,
      secondaryGenre: payload.secondaryGenre,
      preserveCaps: payload.preserveCaps,
      newArtistProfile: payload.newArtistProfile,
      instrumental: payload.instrumental,
      songwriterRole: ROLE_TEXT[payload.songwriterRole] || ROLE_TEXT.both,
      previewStart: payload.previewStartSec != null ? { min: Math.floor(payload.previewStartSec / 60), sec: payload.previewStartSec % 60 } : null,
      credits: payload.credits,
    }).catch(() => ({ done: [], missed: ['genre, language, credits and the other release answers'] }));
    leftForYou.push(...fields.missed);
    if (!payload.genre) leftForYou.push('genre');
    if (!payload.newArtistProfile) leftForYou.push('your existing store profiles (Spotify, Apple, YouTube Music, Instagram, Facebook)');
    await soft('AI disclosure', async () => {
      if (!(await page.evaluate(discloseDistrokidAi, { step: 'gate', ai: payload.ai }))) return false;
      if (!(payload.ai.lyrics || payload.ai.music || payload.ai.vocals)) return true;
      await page.waitForTimeout(1000);
      return page.evaluate(discloseDistrokidAi, { step: 'parts', ai: payload.ai });
    });
    // Paid extras are the director's call, every time: none stays ticked.
    const extras = await page.evaluate(untickDistrokidExtras).catch(() => null);
    if (extras === null) leftForYou.push('check that no paid extras are ticked');
    else if (extras.stillTicked.length) leftForYou.push(`untick the paid extras: ${extras.stillTicked.join(', ')}`);
    await page.evaluate(() => document.querySelector('#js-track-upload-1')?.scrollIntoView({ block: 'center' })).catch(() => {});

    const aiParts = [payload.ai.lyrics && 'lyrics', payload.ai.music && 'music', payload.ai.vocals && 'all of the audio'].filter(Boolean);
    return {
      artist: payload.artist,
      title: payload.title,
      songwriter: `${payload.songwriter.first} ${payload.songwriter.last} (${payload.songwriterRole === 'both' ? 'music and lyrics' : payload.songwriterRole})`,
      releaseDate: payload.releaseDate || 'As soon as possible',
      genre: [payload.genre, payload.secondaryGenre].filter(Boolean).join(' / ') || null,
      language: payload.language,
      explicit: payload.explicit ? 'Yes' : 'No',
      ai: aiParts.length ? aiParts.join(', ') : 'None',
      appleCredits: `${payload.credits.performer} (performer), ${payload.credits.producer} (producer)`,
      preview: payload.previewStartSec != null ? `from ${clock(payload.previewStartSec)}` : null,
      paidExtras: extras === null || extras.stillTicked.length ? null : (extras.unticked.length ? `unticked: ${extras.unticked.join(', ')}` : 'none ticked'),
      leftForYou: [...leftForYou, 'which stores (DistroKid picks all by default)', 'the agreement checkboxes', 'Upload'],
    };
  },
};

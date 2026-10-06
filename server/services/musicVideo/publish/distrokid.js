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
 * DistroKid restyles this form often, so every field is found by its name or
 * its label text, and a field that is no longer there is reported in the
 * summary as left for the director rather than failing the whole draft.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, step } from './browser.js';

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

/** Check the first radio/checkbox whose label text matches `pattern` (a RegExp source). */
async function checkByLabel(page, selector, pattern) {
  return page.evaluate(([sel, src]) => {
    const re = new RegExp(src, 'i');
    const box = [...document.querySelectorAll(sel)].find((b) => re.test((b.closest('label')?.innerText || b.parentElement?.innerText || '').replace(/\s+/g, ' ')));
    if (!box) return false;
    if (!box.checked) box.click();
    return true;
  }, [selector, pattern]);
}

/** Set every checkbox matching `selector` to `on`; false when there is none. */
async function setChecked(page, selector, on) {
  return page.evaluate(([sel, want]) => {
    const boxes = [...document.querySelectorAll(sel)].filter((b) => b.type !== 'hidden');
    for (const b of boxes) if (b.checked !== want) b.click();
    return boxes.length > 0;
  }, [selector, on]);
}

/**
 * Answer a radio question: inside the smallest block whose text matches
 * `question` and that holds radios, click the radio labelled `answer`.
 */
async function answerQuestion(page, question, answer) {
  return page.evaluate(([qSrc, aSrc]) => {
    const q = new RegExp(qSrc, 'i');
    const a = new RegExp(aSrc, 'i');
    const labelOf = (r) => (r.closest('label')?.innerText || r.parentElement?.innerText || r.value || '').replace(/\s+/g, ' ').trim();
    const blocks = [...document.querySelectorAll('div, fieldset, section, tr, li')]
      .filter((el) => q.test(el.innerText || '') && el.querySelector('input[type=radio]'))
      .sort((x, y) => (x.innerText || '').length - (y.innerText || '').length);
    for (const block of blocks) {
      const radio = [...block.querySelectorAll('input[type=radio]')].find((r) => a.test(labelOf(r)));
      if (radio) { if (!radio.checked) radio.click(); return true; }
    }
    return false;
  }, [question, answer]);
}

/** Pick "new profile" on every store-profile question (Spotify, Apple, YouTube Music, Instagram, Facebook). */
async function newStoreProfiles(page) {
  return page.evaluate(() => {
    const names = ['spotifyArtistID', 'appleArtistID', 'googleArtistID', 'instagramProfileArtistID', 'facebookProfileArtistID'];
    let answered = 0;
    for (const name of names) {
      const els = [...document.querySelectorAll(`[name="${name}"]`)];
      const select = els.find((e) => e.tagName === 'SELECT' && [...e.options].some((o) => o.value === 'new'));
      const radio = els.find((e) => e.type === 'radio' && e.value === 'new');
      if (select) {
        select.value = 'new';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (radio) {
        if (!radio.checked) radio.click();
      } else continue;
      answered += 1;
    }
    return answered === names.length;
  });
}

/** Apple Music's required credits: the performer and producer names (and the performer's role, when given). */
async function appleCredits(page, credits) {
  return page.evaluate((c) => {
    const fill = (prefix, name, role) => {
      const fields = [...document.querySelectorAll(`[id^="${prefix}"]`)];
      const text = fields.find((f) => f.tagName === 'INPUT' && f.type === 'text');
      if (!text) return false;
      text.value = name;
      text.dispatchEvent(new Event('input', { bubbles: true }));
      text.dispatchEvent(new Event('change', { bubbles: true }));
      if (!role) return true;
      const select = fields.find((f) => f.tagName === 'SELECT');
      const opt = select && [...select.options].find((o) => o.textContent.trim().toLowerCase() === role.toLowerCase());
      if (!opt) return false;
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    return fill('track-1-performer-1-', c.performer, c.performerRole) && fill('track-1-producer-1-', c.producer, 'Producer');
  }, credits);
}

/** Untick every paid extra (they all share name=extras); the labels of any that were ticked. */
async function untickPaidExtras(page) {
  return page.evaluate(() => [...document.querySelectorAll('input[name=extras]')]
    .filter((b) => b.checked)
    .map((b) => { b.click(); return (b.closest('label')?.innerText || b.value || '').replace(/\s+/g, ' ').trim().slice(0, 60); }));
}

/**
 * Answer DistroKid's AI question and tick the parts the director says AI made.
 * The parts are checkboxes in the form (ai_lyrics_…, ai_music_…, and "all" or
 * "part of the audio"); older forms asked in a pop-up, still handled.
 */
async function discloseAi(page, ai) {
  const any = ai.lyrics || ai.music || ai.vocals;
  const answered = await page.evaluate((yes) => {
    const radio = document.querySelector(`input[type=radio][name^="ai_gate_"][value="${yes ? 1 : 0}"]`);
    if (!radio) return false;
    radio.scrollIntoView({ block: 'center' });
    if (!radio.checked) radio.click();
    return true;
  }, any);
  if (!answered || !any) return answered;
  await page.waitForTimeout(1000);
  return page.evaluate((want) => {
    const labelOf = (b) => (b.closest('label')?.innerText || b.parentElement?.innerText || '').replace(/\s+/g, ' ');
    const set = (box, on) => { if (box && box.checked !== on) box.click(); return !!box; };
    const lyrics = document.querySelector('input[name^="ai_lyrics_"]');
    const music = document.querySelector('input[name^="ai_music_"]');
    if (lyrics || music) {
      const audio = [...document.querySelectorAll('input[name^="ai_"]')].filter((b) => /of the audio/i.test(labelOf(b)));
      const all = audio.find((b) => /all of the audio/i.test(labelOf(b)));
      const part = audio.find((b) => /part of the audio/i.test(labelOf(b)));
      // All of the audio (AI vocals) or, for AI music under a human voice, part of it.
      const audioOk = want.vocals
        ? set(all, true) && (!part || part.type === 'radio' || set(part, false))
        : (!all || all.type === 'radio' || set(all, false)) && (!want.music || !part || set(part, true));
      return set(lyrics, want.lyrics) && set(music, want.music) && audioOk;
    }
    const popup = [...document.querySelectorAll('.swal2-popup')].find((p) => /which parts|ai-generated/i.test(p.innerText || ''));
    if (!popup) return false;
    const tick = (re, on) => set([...popup.querySelectorAll('input[type=checkbox]')].find((b) => re.test(labelOf(b))), on);
    const found = [tick(/lyrics/i, want.lyrics), tick(/music\s*\(composed/i, want.music), tick(/all of the audio/i, want.vocals)];
    const save = [...popup.querySelectorAll('button')].find((b) => /^save$/i.test((b.innerText || '').trim()));
    save?.click();
    return found.every(Boolean) && !!save;
  }, ai);
}

const ROLE_ANSWER = { music: 'music', lyrics: 'lyrics', both: 'both|music and lyrics|lyrics and music' };
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
      if (!(await setValue(page, '#artistName, [name=bandname]', payload.artist))) throw new Error(`no artist field accepted "${payload.artist}"`);
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
    await soft(payload.instrumental ? 'instrumental' : 'contains lyrics', () => checkByLabel(page, 'input[type=radio]', payload.instrumental ? 'instrumental|no lyrics' : 'contains lyrics'));
    if (payload.releaseDate) await soft(`release date ${payload.releaseDate}`, () => setValue(page, '#release-date-dp, input[name=releaseDate]', payload.releaseDate));
    await soft(`songwriter role (${payload.songwriterRole})`, () => answerQuestion(page, 'songwriter|wrote', ROLE_ANSWER[payload.songwriterRole] || ROLE_ANSWER.both));
    await soft('AI disclosure', () => discloseAi(page, payload.ai));
    await soft('previously released: no', () => answerQuestion(page, 'previously released|released before', '^no'));
    await soft(`language (${payload.language})`, () => setValue(page, '#language', payload.language));
    if (payload.genre) await soft(`genre (${payload.genre})`, () => setValue(page, '#genrePrimary', payload.genre));
    else leftForYou.push('genre');
    if (payload.secondaryGenre) await soft(`secondary genre (${payload.secondaryGenre})`, () => setValue(page, '#genreSecondary', payload.secondaryGenre));
    if (payload.newArtistProfile) await soft('store profiles: new on all five', () => newStoreProfiles(page));
    else leftForYou.push('your existing store profiles (Spotify, Apple, YouTube Music, Instagram, Facebook)');
    await soft('Apple Music credits (or untick Apple Music and iTunes)', () => appleCredits(page, payload.credits));
    if (payload.previewStartSec != null) {
      await soft(`preview start ${clock(payload.previewStartSec)}`, () => answerQuestion(page, 'preview|clip', clock(payload.previewStartSec))
        .then((ok) => ok || setValue(page, 'select[name*=preview i], select[id*=preview i], input[name*=preview i]', String(payload.previewStartSec))));
    }
    // Paid extras are the director's call, every time: none stays ticked.
    const unticked = await untickPaidExtras(page).catch(() => null);
    if (unticked === null) leftForYou.push('check that no paid extras are ticked');
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
      paidExtras: unticked?.length ? `unticked: ${unticked.join(', ')}` : 'none',
      leftForYou: [...leftForYou, 'which stores (DistroKid picks all by default)', 'the agreement checkboxes', 'Upload'],
    };
  },
};

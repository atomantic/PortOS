/**
 * DistroKid adapter: the song goes to Spotify (and the other stores DistroKid
 * delivers to) as a single. Spotify has no upload for independent artists, so
 * a distributor is the only route. prepare() fills DistroKid's upload form
 * with the song's audio, a square cover, title, artist, songwriter, explicit
 * and instrumental flags, the AI disclosure, and the release date. It never
 * ticks the agreement boxes or presses Upload: those attest the director owns
 * the rights, so they stay with the director.
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

/** Answer DistroKid's AI question and tick the parts the director says AI made. */
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
    const popup = [...document.querySelectorAll('.swal2-popup')].find((p) => /which parts|ai-generated/i.test(p.innerText || ''));
    if (!popup) return false;
    const tick = (re, on) => {
      const box = [...popup.querySelectorAll('input[type=checkbox]')].find((b) => re.test(b.closest('label')?.innerText || b.parentElement?.innerText || ''));
      if (box && box.checked !== on) box.click();
      return !!box;
    };
    const found = [
      tick(/lyrics/i, want.lyrics),
      tick(/music\s*\(composed/i, want.music),
      tick(/all of the audio/i, want.vocals),
    ];
    const save = [...popup.querySelectorAll('button')].find((b) => /^save$/i.test((b.innerText || '').trim()));
    save?.click();
    return found.every(Boolean) && !!save;
  }, ai);
}

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
    await soft('AI disclosure', () => discloseAi(page, payload.ai));
    await page.evaluate(() => document.querySelector('#js-track-upload-1')?.scrollIntoView({ block: 'center' })).catch(() => {});

    const aiParts = [payload.ai.lyrics && 'lyrics', payload.ai.music && 'music', payload.ai.vocals && 'all of the audio'].filter(Boolean);
    return {
      artist: payload.artist,
      title: payload.title,
      songwriter: `${payload.songwriter.first} ${payload.songwriter.last}`,
      releaseDate: payload.releaseDate || 'As soon as possible',
      explicit: payload.explicit ? 'Yes' : 'No',
      ai: aiParts.length ? aiParts.join(', ') : 'None',
      leftForYou: [...leftForYou, 'the agreement checkboxes', 'Upload'],
    };
  },
};

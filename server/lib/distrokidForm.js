/**
 * DistroKid upload form (distrokid.com/new/): the in-page steps of the
 * release recipe (#10337). Each function runs INSIDE the page through
 * Playwright's `page.evaluate(fn, arg)`, so it is self-contained: it reads
 * only `document` and its argument, never this module's scope. The same
 * functions run against a fixture document in the client's DOM tests.
 *
 * Per-track fields carry a random suffix per page load (`title_<uuid>`), so
 * they are matched by name prefix. Several radios render one variant per
 * situation (the store-profile questions), so the shown one wins.
 */

/**
 * Answer the release and track questions PortOS knows from the song.
 * `plan`: { albumTitle, language, genre, secondaryGenre, preserveCaps,
 * newArtistProfile, instrumental, songwriterRole ('Music' | 'Lyrics' |
 * 'Music and lyrics'), previewStart: { min, sec } | null,
 * credits: { performer, performerRole, producer } }.
 * Resolves `{ done, missed }`: the labels of the steps that took and of those
 * that found no field (left for the director).
 */
export function fillDistrokidFields(plan) {
  const done = [];
  const missed = [];
  const note = (label, ok) => (ok ? done : missed).push(label);
  const shown = (el) => !el.closest('[hidden], [style*="display: none"], [style*="display:none"]')
    && (typeof el.checkVisibility !== 'function' || el.checkVisibility());
  const fire = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Only a shown variant is answered: a question DistroKid hid (an artist it
  // already knows) is not answered behind the director's back.
  const radio = (selector, value) => {
    const pick = [...document.querySelectorAll(selector)].filter((r) => r.value === value).find(shown);
    if (!pick) return false;
    if (!pick.checked) pick.click();
    return true;
  };
  const choose = (el, want) => {
    if (!el || el.tagName !== 'SELECT') return false;
    const w = String(want).toLowerCase();
    const opt = [...el.options].find((o) => o.value.toLowerCase() === w || o.textContent.trim().toLowerCase() === w);
    if (!opt) return false;
    el.value = opt.value;
    fire(el);
    return true;
  };
  const type = (el, value) => {
    if (!el) return false;
    el.value = value;
    fire(el);
    return true;
  };
  const tick = (el, on) => {
    if (!el) return false;
    if (el.checked !== on) el.click();
    return true;
  };
  // The nearest ancestor of `el` holding at least `count` elements matching `selector`.
  const around = (el, selector, count = 1) => {
    for (let node = el?.parentElement; node; node = node.parentElement) {
      if (node.querySelectorAll(selector).length >= count) return node;
    }
    return null;
  };

  note('previously released: no', radio('input[name^="previouslyReleased_"]', '0'));
  if (plan.preserveCaps) note('keep the artist name\'s capitalization', tick(document.querySelector('#checkboxPreserveNonStandardCaps'), true));
  if (plan.newArtistProfile) {
    const names = ['spotifyArtistID', 'appleArtistID', 'googleArtistID', 'instagramProfileArtistID', 'facebookProfileArtistID'];
    const answered = names.filter((n) => {
      const select = [...document.querySelectorAll(`select[name="${n}"]`)].find((s) => [...s.options].some((o) => o.value === 'new'));
      return select ? choose(select, 'new') : radio(`input[name="${n}"]`, 'new');
    });
    note('store profiles: new on all five', answered.length === names.length);
  }
  note(`language (${plan.language})`, choose(document.querySelector('#language'), plan.language));
  if (plan.genre) note(`genre (${plan.genre})`, choose(document.querySelector('#genrePrimary'), plan.genre));
  if (plan.secondaryGenre) note(`secondary genre (${plan.secondaryGenre})`, choose(document.querySelector('#genreSecondary'), plan.secondaryGenre));
  if (plan.albumTitle) note('release title', type(document.querySelector('#albumTitleInput'), plan.albumTitle));
  note('no featured artist', radio('input[name^="feat_"]', '0'));
  note('normal version (not a radio edit)', radio('input[name^="version_"]', ''));
  note('no Dolby Atmos', radio('input[name^="dolby_"]', '0'));
  note('original song (not a cover)', radio('input[name^="coversong_"]', '0'));
  note('not a clean version', radio('input[name^="cleaned_"]', '0'));
  note(plan.instrumental ? 'instrumental' : 'has lyrics', radio('input[name^="instrumental_"]', plan.instrumental ? '1' : '0'));

  const firstName = document.querySelector('[name^="songwriter_real_name_first"]');
  const roleBox = around(firstName, 'select');
  const roleSelect = roleBox && [...roleBox.querySelectorAll('select')].find((s) => [...s.options].some((o) => /music and lyrics/i.test(o.textContent)));
  note(`songwriter role (${plan.songwriterRole})`, choose(roleSelect, plan.songwriterRole));

  if (plan.previewStart) {
    const yes = [...document.querySelectorAll('input[name="previewStart_1"]')].find((r) => r.value === 'yes');
    let ok = !!yes && radio('input[name="previewStart_1"]', 'yes');
    if (ok) {
      const selects = [...(around(yes, 'select', 2)?.querySelectorAll('select') || [])];
      const at = (el, n) => {
        // A blank placeholder is not minute 0.
        const opt = el && [...el.options].find((o) => {
          const raw = (o.value || o.textContent).trim();
          return raw !== '' && Number(raw) === n;
        });
        if (!opt) return false;
        el.value = opt.value;
        fire(el);
        return true;
      };
      ok = selects.length >= 2 && at(selects[0], plan.previewStart.min) && at(selects[1], plan.previewStart.sec);
    }
    note(`preview start ${plan.previewStart.min}:${String(plan.previewStart.sec).padStart(2, '0')}`, ok);
  }

  const c = plan.credits || {};
  const performer = type(document.querySelector('#track-1-performer-1-name'), c.performer)
    && (c.performerRole
      ? choose(document.querySelector('#track-1-performer-1-role'), c.performerRole)
      : !!document.querySelector('#track-1-performer-1-role')?.value);
  const producer = type(document.querySelector('#track-1-producer-1-name'), c.producer)
    && choose(document.querySelector('#track-1-producer-1-role'), 'Producer');
  note('Apple Music credits (or untick Apple Music and iTunes)', performer && producer);
  return { done, missed };
}

/**
 * The AI disclosure, in two steps because the parts appear once the gate says
 * yes. `{ step: 'gate', ai }` answers the gate; `{ step: 'parts', ai }` ticks
 * lyrics, music, and all of the audio (AI vocals) or part of it (AI
 * instruments under a human voice), then presses the parts modal's Save when
 * DistroKid shows them in one. `ai`: { lyrics, music, vocals }.
 * Resolves true when every field it needed was there.
 */
export function discloseDistrokidAi({ step, ai }) {
  const any = !!(ai.lyrics || ai.music || ai.vocals);
  const set = (el, on) => {
    if (!el) return false;
    if (el.checked !== on) el.click();
    return true;
  };
  if (step === 'gate') {
    const gate = document.querySelector(`input[type=radio][name^="ai_gate_"][value="${any ? 1 : 0}"]`);
    if (!gate) return false;
    gate.scrollIntoView?.({ block: 'center' });
    return set(gate, true);
  }
  // The parts now open in a SweetAlert modal whose audio-scope boxes carry no name.
  const scope = (value) => document.querySelector(`input[name^="ai_"][value="${value}"], input.distroAiRecordingScope[value="${value}"]`);
  const full = scope('full');
  const partial = scope('partial');
  const partialAudio = !ai.vocals && ai.music;
  let audio = set(full, !!ai.vocals) && set(partial, partialAudio);
  if (audio && partialAudio) {
    const kinds = [...document.querySelectorAll('[name^="ai_partial_audio_type_"]')];
    const select = kinds.find((k) => k.tagName === 'SELECT');
    if (select) {
      audio = [...select.options].some((o) => o.value === 'instruments');
      if (audio) {
        select.value = 'instruments';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      audio = set(kinds.find((k) => k.value === 'instruments'), true);
    }
  }
  const parts = set(document.querySelector('input[name^="ai_lyrics_"]'), !!ai.lyrics)
    && set(document.querySelector('input[name^="ai_music_"]'), !!ai.music)
    && audio;
  // The modal keeps nothing until Save, and closing it any other way resets the gate to No.
  const save = document.querySelector('.ai-credits-swal-modal .swal2-confirm');
  if (parts && save) save.click();
  return parts;
}

/**
 * Untick every paid extra (they share name=extras). Resolves `{ unticked,
 * stillTicked }`: the labels of the ones it unticked, and of any whose click
 * did not take (a handler or a confirm blocked it).
 */
export function untickDistrokidExtras() {
  const labelOf = (b) => (b.closest('label')?.textContent || b.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const ticked = [...document.querySelectorAll('input[name=extras]')].filter((b) => b.checked);
  for (const b of ticked) b.click();
  return {
    unticked: ticked.filter((b) => !b.checked).map(labelOf),
    stillTicked: ticked.filter((b) => b.checked).map(labelOf),
  };
}

/**
 * Set the release's artist. A plan with several artists shows a field (or a
 * picker); an account with one artist renders it as a hidden input that
 * already holds that artist, so there it is only checked (ignoring case and
 * spacing). Resolves
 * `{ ok, fixed }`: `fixed` is the account's own artist when the form does not
 * let it change, so a mismatch can name both.
 */
export function setDistrokidArtist(artist) {
  const fields = [...document.querySelectorAll('#artistName, [name=bandname]')];
  const field = fields.find((e) => e.type !== 'hidden');
  if (field) {
    if (field.tagName === 'SELECT') {
      const want = artist.toLowerCase();
      const opt = [...field.options].find((o) => o.value === artist || o.textContent.trim().toLowerCase() === want);
      if (!opt) return { ok: false, fixed: null };
      field.value = opt.value;
    } else {
      field.focus();
      field.value = artist;
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur?.();
    return { ok: true, fixed: null };
  }
  // DistroKid may store the name with different case or spacing ("exampleartist" for "Example Artist").
  const squash = (v) => v.replace(/\s+/g, '').toLowerCase();
  const fixed = fields.find((e) => e.value.trim())?.value.trim() || null;
  return { ok: !!fixed && squash(fixed) === squash(artist), fixed };
}

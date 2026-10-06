// The DistroKid recipe's in-page steps (server/lib/distrokidForm.js) run in the
// browser through page.evaluate, so they are tested here, against a fixture of
// the upload form's fields (#10337), in the client's DOM environment.
import { describe, it, expect, beforeEach } from 'vitest';
import { discloseDistrokidAi, fillDistrokidFields, setDistrokidArtist, untickDistrokidExtras } from '../../../server/lib/distrokidForm.js';

const radios = (name, values) => values.map((v) => `<label><input type="radio" name="${name}" value="${v}">${v}</label>`).join('');
const options = (values) => values.map((v) => `<option value="${v}">${v}</option>`).join('');
const range = (n) => Array.from({ length: n }, (_, i) => String(i));

const FORM = `
  <label><input type="checkbox" name="extras" value="socialmediapack" id="socialmediapack" checked>Social Media Pack</label>
  ${radios('previouslyReleased_ab12', ['0', '1'])}
  <input type="checkbox" id="checkboxPreserveNonStandardCaps">
  <div hidden>${radios('spotifyArtistID', ['new'])}</div>
  <div>${radios('spotifyArtistID', ['', 'new'])}</div>
  <select name="appleArtistID"><option value="">Pick</option><option value="new">New profile</option></select>
  ${radios('googleArtistID', ['new'])}${radios('instagramProfileArtistID', ['new'])}${radios('facebookProfileArtistID', ['new'])}
  <select id="language">${options(['', 'English', 'Spanish'])}</select>
  <select id="genrePrimary">${options(['', 'Alternative', 'Electronic', 'Pop'])}</select>
  <select id="genreSecondary">${options(['', 'Alternative', 'Electronic', 'Pop'])}</select>
  <input id="albumTitleInput" name="albumtitle">
  ${radios('feat_cd34', ['0', '1'])}${radios('version_cd34', ['', 'Radio Edit'])}${radios('dolby_1', ['0', '1'])}
  ${radios('coversong_cd34', ['0', '1'])}${radios('cleaned_cd34', ['0', '1'])}${radios('instrumental_cd34', ['0', '1'])}
  <div class="songwriter">
    <select><option>Music</option><option>Lyrics</option><option>Music and lyrics</option></select>
    <input name="songwriter_real_name_first1"><input name="songwriter_real_name_last1">
  </div>
  <div class="preview">${radios('previewStart_1', ['no', 'yes'])}<select><option value=""></option>${options(range(10))}</select><select>${options(range(60))}</select></div>
  <select id="track-1-performer-1-role">${options(['', 'Vocals', 'Synthesizer'])}</select><input id="track-1-performer-1-name">
  <select id="track-1-producer-1-role">${options(['', 'Producer', 'Mixing Engineer'])}</select><input id="track-1-producer-1-name">
  ${radios('ai_gate_cd34', ['0', '1'])}
  <label><input type="checkbox" name="ai_lyrics_cd34">Lyrics</label>
  <label><input type="checkbox" name="ai_music_cd34">Music</label>
  <label><input type="checkbox" name="ai_audio_cd34" value="full">All of the audio</label>
  <label><input type="checkbox" name="ai_audio_cd34" value="partial">Part of the audio</label>
  ${radios('ai_partial_audio_type_cd34', ['vocals', 'instruments'])}
  <label><input type="checkbox" name="extras" value="legacy" checked>Leave a Legacy</label>
  <label><input type="checkbox" name="extras" value="distrovid">DistroVid</label>
`;

const PLAN = {
  albumTitle: 'Example Song', language: 'English', genre: 'Electronic', secondaryGenre: 'Pop', preserveCaps: true,
  newArtistProfile: true, instrumental: false, songwriterRole: 'Music and lyrics', previewStart: { min: 1, sec: 5 },
  credits: { performer: 'Alice Example', performerRole: 'Vocals', producer: 'Alice Example' },
};
const $ = (sel) => document.querySelector(sel);
const checked = (name) => document.querySelector(`input[name^="${name}"]:checked`)?.value;

describe('DistroKid form recipe', () => {
  beforeEach(() => { document.body.innerHTML = FORM; });

  it('answers every release and track question PortOS knows from the song', () => {
    const { missed } = fillDistrokidFields(PLAN);
    expect(missed).toEqual([]);
    expect(checked('previouslyReleased_')).toBe('0');
    expect($('#checkboxPreserveNonStandardCaps').checked).toBe(true);
    // The shown variant of a profile question is the one answered.
    expect([...document.querySelectorAll('input[name=spotifyArtistID][value=new]')].map((r) => r.checked)).toEqual([false, true]);
    expect($('select[name=appleArtistID]').value).toBe('new');
    expect([$('#language').value, $('#genrePrimary').value, $('#genreSecondary').value, $('#albumTitleInput').value]).toEqual(['English', 'Electronic', 'Pop', 'Example Song']);
    expect(['feat_', 'version_', 'dolby_', 'coversong_', 'cleaned_', 'instrumental_'].map(checked)).toEqual(['0', '', '0', '0', '0', '0']);
    expect($('.songwriter select').value).toBe('Music and lyrics');
    expect(checked('previewStart_')).toBe('yes');
    expect([...document.querySelectorAll('.preview select')].map((s) => s.value)).toEqual(['1', '5']);
    expect([$('#track-1-performer-1-name').value, $('#track-1-performer-1-role').value, $('#track-1-producer-1-name').value, $('#track-1-producer-1-role').value])
      .toEqual(['Alice Example', 'Vocals', 'Alice Example', 'Producer']);
  });

  it('reports a field the form no longer has instead of failing', () => {
    $('#genrePrimary').remove();
    $('#track-1-producer-1-name').remove();
    const { missed } = fillDistrokidFields(PLAN);
    expect(missed).toEqual(['genre (Electronic)', 'Apple Music credits (or untick Apple Music and iTunes)']);
  });

  it('leaves the Apple credits for the director when no performer role was given and none is selected', () => {
    const { missed } = fillDistrokidFields({ ...PLAN, credits: { ...PLAN.credits, performerRole: null } });
    expect(missed).toEqual(['Apple Music credits (or untick Apple Music and iTunes)']);
  });

  it('discloses AI vocals as all of the audio, and AI music under a human voice as part of it', () => {
    expect(discloseDistrokidAi({ step: 'gate', ai: { lyrics: false, music: true, vocals: true } })).toBe(true);
    expect(checked('ai_gate_')).toBe('1');
    expect(discloseDistrokidAi({ step: 'parts', ai: { lyrics: false, music: true, vocals: true } })).toBe(true);
    const box = (sel) => $(sel).checked;
    expect([box('[name^=ai_lyrics_]'), box('[name^=ai_music_]'), box('[value=full]'), box('[value=partial]')]).toEqual([false, true, true, false]);
    expect(discloseDistrokidAi({ step: 'parts', ai: { lyrics: true, music: true, vocals: false } })).toBe(true);
    expect([box('[name^=ai_lyrics_]'), box('[value=full]'), box('[value=partial]')]).toEqual([true, false, true]);
    expect(checked('ai_partial_audio_type_')).toBe('instruments');
    expect(discloseDistrokidAi({ step: 'gate', ai: { lyrics: false, music: false, vocals: false } })).toBe(true);
    expect(checked('ai_gate_')).toBe('0');
  });

  it('leaves no paid extra ticked, and names the ones it unticked', () => {
    expect(untickDistrokidExtras()).toEqual({ unticked: ['Social Media Pack', 'Leave a Legacy'], stillTicked: [] });
    expect(document.querySelectorAll('input[name=extras]:checked')).toHaveLength(0);
  });

  it('reports a paid extra whose untick did not take', () => {
    $('input[value=legacy]').addEventListener('click', (e) => e.preventDefault());
    expect(untickDistrokidExtras()).toEqual({ unticked: ['Social Media Pack'], stillTicked: ['Leave a Legacy'] });
  });

  it('starts the preview at minute 0 on the real option, not the blank placeholder', () => {
    fillDistrokidFields({ ...PLAN, previewStart: { min: 0, sec: 42 } });
    const [min, sec] = document.querySelectorAll('.preview select');
    expect([min.selectedIndex, min.value, sec.value]).toEqual([1, '0', '42']);
  });

  it('leaves a store-profile question DistroKid hid for the director', () => {
    document.querySelectorAll('input[name=spotifyArtistID]').forEach((r) => r.closest('label').setAttribute('hidden', ''));
    const { missed } = fillDistrokidFields(PLAN);
    expect(missed).toEqual(['store profiles: new on all five']);
    expect(document.querySelector('input[name=spotifyArtistID]:checked')).toBeNull();
  });
});

describe('DistroKid artist', () => {
  it('types the artist into the field a multi-artist plan shows', () => {
    document.body.innerHTML = '<input id="artistName" name="bandname">';
    expect(setDistrokidArtist('Example Artist')).toEqual({ ok: true, fixed: null });
    expect(document.querySelector('#artistName').value).toBe('Example Artist');
  });

  it('picks the artist from a picker by its shown name', () => {
    document.body.innerHTML = '<select name="bandname"><option value="">Pick</option><option value="a1">Example Artist</option></select>';
    expect(setDistrokidArtist('example artist')).toEqual({ ok: true, fixed: null });
    expect(document.querySelector('select').value).toBe('a1');
  });

  it("accepts a single-artist account's hidden artist when it matches", () => {
    document.body.innerHTML = '<input type="hidden" id="artistName" name="bandname" value="exampleartist">';
    expect(setDistrokidArtist('ExampleArtist')).toEqual({ ok: true, fixed: 'exampleartist' });
  });

  it('matches the hidden artist across case and spacing, and reports the account spelling', () => {
    document.body.innerHTML = '<input type="hidden" id="artistName" name="bandname" value=" exampleartist ">';
    expect(setDistrokidArtist('Example Artist')).toEqual({ ok: true, fixed: 'exampleartist' });
    expect(setDistrokidArtist(' Example  Artist ')).toEqual({ ok: true, fixed: 'exampleartist' });
  });

  it("names the account's own artist when it differs", () => {
    document.body.innerHTML = '<input type="hidden" id="artistName" name="bandname" value="exampleartist">';
    expect(setDistrokidArtist('Someone Else')).toEqual({ ok: false, fixed: 'exampleartist' });
  });

  it('fails when the form has no artist field', () => {
    document.body.innerHTML = '';
    expect(setDistrokidArtist('Example Artist')).toEqual({ ok: false, fixed: null });
  });
});

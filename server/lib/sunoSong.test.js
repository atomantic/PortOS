import { describe, it, expect } from 'vitest';
import { isSunoSongUrl, sunoSongIdFromUrl, parseSunoSongPage } from './sunoSong.js';

const ID = '11111111-2222-4333-8444-555555555555';
const PARENT = '99999999-8888-4777-8666-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Wrap flight-stream text the way a Next.js page ships it: one JSON string literal per push.
const page = (chunks, head = '') => `<html><head>${head}</head><body>${chunks
  .map((c) => `<script>self.__next_f.push([1,${JSON.stringify(c)}])</script>`).join('')}</body></html>`;
const textRow = (ref, text) => `${ref}:T${new TextEncoder().encode(text).length.toString(16)},${text}`;

describe('Suno song URLs', () => {
  it.each([
    [`https://suno.com/song/${ID}`, ID],
    [`https://www.suno.com/song/${ID.toUpperCase()}?sh=abc`, ID],
    [`https://app.suno.ai/song/${ID}/`, ID],
    ['https://suno.com/s/AbCdEf123456', null],
  ])('accepts %s', (url, id) => {
    expect(isSunoSongUrl(url)).toBe(true);
    expect(sunoSongIdFromUrl(url)).toBe(id);
  });

  it.each([
    'https://suno.com/create',
    `https://suno.com/playlist/${ID}`,
    `https://evilsuno.com/song/${ID}`,
    `https://suno.com.example.com/song/${ID}`,
    `https://suno.com/song/${ID} extra`,
  ])('rejects %s', (url) => {
    expect(isSunoSongUrl(url)).toBe(false);
  });
});

describe('parseSunoSongPage', () => {
  it('reads the song record, resolving long lyrics from a text row, whatever its key order', () => {
    const lyrics = '[Verse]\nThe "room" is {you} — ünïcödé\n[Chorus]\nYou are the room';
    const record = {
      title: 'You Are the Room',
      metadata: { tags: 'industrial, glitch', prompt: '$2a', history: [{ id: PARENT, title: 'Parent take' }] },
      id: ID,
      audio_url: `https://cdn1.suno.ai/${ID}.mp3`,
      image_large_url: `https://cdn2.suno.ai/image_large_${ID}.jpeg`,
    };
    const related = { id: OTHER, title: 'Someone else', metadata: { prompt: 'not these lyrics', tags: 'pop' } };
    const html = page([`1:${JSON.stringify(['$', 'div', null, { related }])}\n`, textRow('2a', lyrics), `3:${JSON.stringify({ clip: record })}\n`]);
    expect(parseSunoSongPage(html, ID)).toEqual({
      title: 'You Are the Room',
      lyrics,
      style: 'industrial, glitch',
      audioUrl: `https://cdn1.suno.ai/${ID}.mp3`,
      imageUrl: `https://cdn2.suno.ai/image_large_${ID}.jpeg`,
    });
  });

  it('prefers the full record over a slimmer listing of the same song', () => {
    const html = page([`4:${JSON.stringify({ playbar: { id: ID, title: 'Short' }, song: { id: ID, title: 'Full', metadata: { prompt: 'words', tags: 'rock' } } })}\n`]);
    expect(parseSunoSongPage(html, ID)).toMatchObject({ title: 'Full', lyrics: 'words', style: 'rock' });
  });

  it('ignores an audio_url that is an API placeholder rather than CDN media', () => {
    const html = page([`6:${JSON.stringify({ song: { id: ID, title: 'T', audio_url: 'https://studio-api.prod.suno.com/api/forbidden', metadata: {} } })}\n`]);
    expect(parseSunoSongPage(html, ID).audioUrl).toBeNull();
  });

  it('falls back to og: tags and refuses media URLs off Suno', () => {
    const head = '<meta property="og:title" content="Rock &amp; Roll | Suno"><meta property="og:image" content="https://evil.example/x.jpg">'
      + `<meta property="og:audio" content="https://cdn1.suno.ai/${ID}.mp3">`;
    expect(parseSunoSongPage(page([], head), ID)).toEqual({
      title: 'Rock & Roll', lyrics: '', style: '', audioUrl: `https://cdn1.suno.ai/${ID}.mp3`, imageUrl: null,
    });
  });

  it('returns empty fields for a page that carries nothing (a challenge page)', () => {
    expect(parseSunoSongPage('<html>Just a moment…</html>', ID)).toEqual({ title: '', lyrics: '', style: '', audioUrl: null, imageUrl: null });
  });
});

// The Suno recipe's in-page steps (server/lib/sunoPage.js) run in the browser
// through page.evaluate, so they are tested here against fixtures of the song
// page, in the client's DOM environment.
import { describe, it, expect } from 'vitest';
import { markSunoSongMenu } from '../../../server/lib/sunoPage.js';

const OWN = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const menu = (tag) => `<button aria-label="More options" data-tag="${tag}"></button>`;
const card = (id, tag) => `<div><div><a href="/song/${id}">Song</a></div><div>${menu(tag)}</div></div>`;
const marked = () => document.querySelector('[data-portos-song-menu]')?.dataset.tag;

describe('markSunoSongMenu', () => {
  it("picks the cover's own menu, not the 'Cover of' card above it", () => {
    // Shaped like a live cover page: the parent's card and its menu come first,
    // inside the header that holds the page song's menu.
    document.body.innerHTML = `
      <main><section><div>${card(PARENT, 'parent')}<div><span>styles</span>${menu('header')}</div></div></section>
        <aside>${card(OTHER, 'similar')}</aside></main>
      <footer>${card(OWN, 'playbar')}</footer>`;
    expect(markSunoSongMenu(OWN)).toBe(true);
    expect(marked()).toBe('header');
  });

  it("picks the song's menu on a page with no other song above it", () => {
    document.body.innerHTML = `<main><section>${menu('header')}</section><aside>${card(OTHER, 'similar')}</aside></main>`;
    expect(markSunoSongMenu(OWN)).toBe(true);
    expect(marked()).toBe('header');
  });

  it("accepts a single-menu card that links to the page's own song, ignoring case", () => {
    document.body.innerHTML = `<aside>${card(OTHER, 'similar')}</aside>${card(OWN, 'own')}`;
    expect(markSunoSongMenu(OWN.toUpperCase())).toBe(true);
    expect(marked()).toBe('own');
  });

  it("fails rather than open another song's menu", () => {
    document.body.innerHTML = `${card(PARENT, 'parent')}<aside>${card(OTHER, 'similar')}</aside>`;
    expect(markSunoSongMenu(OWN)).toBe(false);
    expect(marked()).toBeUndefined();
  });

  it('moves the mark when run again', () => {
    document.body.innerHTML = `${card(OWN, 'a')}`;
    markSunoSongMenu(OWN);
    document.body.insertAdjacentHTML('afterbegin', `<section>${menu('b')}</section>`);
    markSunoSongMenu(OWN);
    expect(document.querySelectorAll('[data-portos-song-menu]')).toHaveLength(1);
    expect(marked()).toBe('b');
  });
});

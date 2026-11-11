// The Suno recipe's in-page steps (server/lib/sunoPage.js) run in the browser
// through page.evaluate, so they are tested here against fixtures of the song
// page, in the client's DOM environment.
import { describe, it, expect } from 'vitest';
import { markSunoSongMenu, sunoDownloadDialogSong } from '../../../server/lib/sunoPage.js';

const OWN = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const menu = (tag) => `<button aria-label="More options" data-tag="${tag}"></button>`;
// The label Suno now gives the menu of the song a page or playbar is showing.
const titledMenu = (name, tag) => `<button aria-label="More options for ${name}" data-tag="${tag}"></button>`;
const card = (id, tag) => `<div><div><a href="/song/${id}">Song</a></div><div>${menu(tag)}</div></div>`;
const marked = () => document.querySelector('[data-portos-song-menu]')?.dataset.tag;

const title = '<h1>Page song</h1>';
const link = (id) => `<a href="/song/${id}">Song</a>`;

describe('markSunoSongMenu', () => {
  it("picks the cover's own menu, not the 'Cover of' card above it", () => {
    // Shaped like a live cover page: the parent's card and its menu come first,
    // inside the header that holds the page song's title and menu.
    document.body.innerHTML = `
      <main><section><div>${card(PARENT, 'parent')}<div>${title}<span>styles</span>${menu('header')}</div></div></section>
        <aside>${card(OTHER, 'similar')}</aside></main>
      <footer>${card(OWN, 'playbar')}</footer>`;
    expect(markSunoSongMenu(OWN)).toBe(true);
    expect(marked()).toBe('header');
  });

  it("picks the page song's menu when the 'Cover of' link and its menu are separate siblings in the header", () => {
    // The shape a Suno redesign could produce: no card wraps the link and its
    // menu, so the header holds both menus. The parent's menu still follows the
    // parent's link; only the title's menu follows the title.
    document.body.innerHTML = `
      <header><div>${link(PARENT)}${menu('parent')}</div>${title}<div><button>Edit</button>${menu('header')}</div></header>
      <aside>${card(OTHER, 'similar')}</aside>`;
    expect(markSunoSongMenu(OWN)).toBe(true);
    expect(marked()).toBe('header');
  });

  it("fails rather than guess when two menus both follow the title", () => {
    document.body.innerHTML = `<header>${title}${menu('a')}${menu('b')}</header>`;
    expect(markSunoSongMenu(OWN)).toBe(false);
    expect(marked()).toBeUndefined();
  });

  it("fails when the parent's menu is the only menu after the title", () => {
    document.body.innerHTML = `<header>${title}${link(PARENT)}${menu('parent')}</header><aside>${card(OTHER, 'similar')}</aside>`;
    expect(markSunoSongMenu(OWN)).toBe(false);
    expect(marked()).toBeUndefined();
  });

  it("accepts a menu that follows a link to the page's own song, ignoring case", () => {
    document.body.innerHTML = `<aside>${card(OTHER, 'similar')}</aside>${card(OWN, 'own')}`;
    expect(markSunoSongMenu(OWN.toUpperCase())).toBe(true);
    expect(marked()).toBe('own');
  });

  it("fails rather than open another song's menu", () => {
    document.body.innerHTML = `${card(PARENT, 'parent')}<aside>${card(OTHER, 'similar')}</aside>`;
    expect(markSunoSongMenu(OWN)).toBe(false);
    expect(marked()).toBeUndefined();
  });

  it('fails on a page with a menu but no title or own-song link to tie it to', () => {
    document.body.innerHTML = `<main><section>${menu('header')}</section></main>`;
    expect(markSunoSongMenu(OWN)).toBe(false);
  });

  it('moves the mark when run again', () => {
    document.body.innerHTML = `${card(OWN, 'a')}`;
    markSunoSongMenu(OWN);
    document.body.innerHTML = `${title}${menu('b')}`;
    markSunoSongMenu(OWN);
    expect(document.querySelectorAll('[data-portos-song-menu]')).toHaveLength(1);
    expect(marked()).toBe('b');
  });

  it("picks the header menu named after the page title, not the plainly labelled cards below it", () => {
    // Shaped like the live page (2026-11): only the page song's menu is named
    // after a title, every "More by" / "Similar" card keeps the plain label,
    // and the playbar repeats the page song's link and titled menu.
    document.body.innerHTML = `
      <main><header>${title}<button aria-label="Play"></button>${titledMenu('Page song', 'header')}</header>
        <section><div role="group" aria-label="Other song">${link(OTHER)}${menu('more-by')}</div></section>
        <section><div role="group" aria-label="Parent song">${link(PARENT)}${menu('similar')}</div></section></main>
      <div>${link(OWN)}${titledMenu('Page song', 'playbar')}</div>`;
    expect(markSunoSongMenu(OWN)).toBe(true);
    expect(marked()).toBe('header');
  });

  it("does not take a menu after the title that is named after another song", () => {
    document.body.innerHTML = `<header>${title}${titledMenu('Parent song', 'parent')}</header>`;
    expect(markSunoSongMenu(OWN)).toBe(false);
    expect(marked()).toBeUndefined();

    document.body.innerHTML = `<header>${title}${titledMenu('Parent song', 'parent')}${titledMenu('Page song', 'header')}</header>`;
    expect(markSunoSongMenu(OWN)).toBe(true);
    expect(marked()).toBe('header');
  });
});

describe('sunoDownloadDialogSong', () => {
  // The live dialog: its heading is "Download" followed by the quoted title.
  const dialog = (heading) => `<div role="dialog" aria-labelledby="download-heading"><button aria-label="Close"></button>
    <h2 id="download-heading">${heading}</h2><button>M4A</button><button>Download</button></div>`;
  const naming = (name) => `<span>Download</span><span>'${name}'</span>`;

  it("tells the page song's dialog from another song's by the title it quotes", () => {
    document.body.innerHTML = `${title}${dialog(naming('Page song'))}`;
    expect(sunoDownloadDialogSong()).toBe('page');

    document.body.innerHTML = `${title}${dialog(naming('Other song'))}`;
    expect(sunoDownloadDialogSong()).toBe('other');
  });

  it('reads a title that carries its own quotes, and one cut short with an ellipsis', () => {
    document.body.innerHTML = `<h1>She's 'Here'</h1>${dialog(naming("She's 'Here'"))}`;
    expect(sunoDownloadDialogSong()).toBe('page');

    document.body.innerHTML = `<h1>A very long page song title</h1>${dialog(naming('A very long page…'))}`;
    expect(sunoDownloadDialogSong()).toBe('page');

    document.body.innerHTML = `<h1>A very long page song title</h1>${dialog(naming('Another long…'))}`;
    expect(sunoDownloadDialogSong()).toBe('other');
  });

  it('is unknown without a Download dialog, a quoted title, or a page title to compare', () => {
    document.body.innerHTML = title;
    expect(sunoDownloadDialogSong()).toBe('unknown');

    document.body.innerHTML = `${title}<div role="dialog"><h2>Publish</h2></div>`;
    expect(sunoDownloadDialogSong()).toBe('unknown');

    document.body.innerHTML = `${title}${dialog('<span>Download</span>')}`;
    expect(sunoDownloadDialogSong()).toBe('unknown');

    document.body.innerHTML = dialog(naming('Page song'));
    expect(sunoDownloadDialogSong()).toBe('unknown');
  });
});

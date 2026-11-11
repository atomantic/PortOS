/**
 * Suno song page (suno.com/song/<id>): in-page steps for the publish recipe
 * and the M4A export. Marker/inspection functions run INSIDE the page through Playwright's
 * `page.evaluate(fn, arg)`, so it reads only `document` and its argument. The
 * same functions run against fixture documents in the client's DOM tests.
 */

export const SUNO_SONG_MENU_SELECTOR = "button[aria-label^='More options']";

/** Wait for an authenticated song UI or an explicit sign-in redirect. A slow UI is a timeout, not proof of logout. */
export async function waitForSunoSongPage(page, { timeoutMs = 60_000 } = {}) {
  const result = await page.waitForFunction(markSunoSongMenu, {
    menuSelector: SUNO_SONG_MENU_SELECTOR, readiness: true,
  }, { timeout: timeoutMs });
  return result.jsonValue();
}

/**
 * Mark the page song's own "More options" button with `data-portos-song-menu`
 * and resolve true, or false when it cannot be told apart from another song's.
 * The page shows other songs' menus too: a cover's "Cover of" song for the song
 * it covers, the More-by-this-creator / Similar cards, and the playbar. A menu
 * is attributed to the nearest song link or title heading before it in document
 * order, and counts as the page song's only when that is the page's `h1` title
 * or a link to the page's own song. The header menu follows the title; another
 * song's menu follows that song's link, wherever the two sit in the markup.
 * Suno labels the page song's menu "More options for <title>" and the cards'
 * menus plain "More options" (older pages: plain on both), so a menu after the
 * title whose label names a song must name the page's title.
 * Two menus owned by the title is ambiguous, so it fails rather than guess.
 */
// Pass the selector explicitly: Playwright serializes this function without module scope.
export function markSunoSongMenu({ songId, menuSelector, readiness = false }) {
  if (readiness) {
    if (/sign-?in|login|accounts\./i.test(location.href)) return 'signed-out';
    songId = location.pathname?.match(/\/song\/([0-9a-f-]{36})/i)?.[1]
      || location.href.match(/\/song\/([0-9a-f-]{36})/i)?.[1];
  }
  if (!songId) return false;
  for (const old of document.querySelectorAll('[data-portos-song-menu]')) old.removeAttribute('data-portos-song-menu');
  const wanted = songId.toLowerCase();
  const squash = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const titled = 'More options for ';
  const byTitle = [];
  const byOwnLink = [];
  let owner = null;
  let title = '';
  for (const el of document.querySelectorAll(`h1, a[href*='/song/'], ${menuSelector}`)) {
    if (el.tagName === 'BUTTON') {
      const label = squash(el.getAttribute('aria-label'));
      if (label !== 'More options' && !label.startsWith(titled)) continue;
      const names = label.startsWith(titled) ? label.slice(titled.length) : null;
      if (owner === 'title' && (names === null || names === title)) byTitle.push(el);
      else if (owner === 'own') byOwnLink.push(el);
    } else if (el.tagName === 'H1') {
      owner = 'title';
      title = squash(el.textContent);
    } else {
      const id = (el.getAttribute('href') || '').match(/\/song\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
      owner = id === wanted ? 'own' : 'other';
    }
  }
  if (byTitle.length > 1) return false;
  const own = byTitle[0] || byOwnLink[0];
  if (!own) return false;
  own.setAttribute('data-portos-song-menu', '');
  return readiness ? 'ready' : true;
}

/**
 * Which song the open Download dialog is for, judged by the title its heading
 * quotes ("Download '<title>'"): `page` when that is the page's `h1` title,
 * `other` when it is a different one, `unknown` when no Download dialog is
 * open, its heading quotes no title, or the page has none to compare. The
 * dialog carries no song id and two songs may share a title, so `page` is not
 * proof; `other` is. Only the verdict leaves the page, never a title.
 */
export function sunoDownloadDialogSong() {
  const squash = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const title = squash(document.querySelector('h1')?.textContent);
  for (const dialog of [...document.querySelectorAll("[role='dialog']")].reverse()) {
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const heading = squash(((labelledBy && document.getElementById(labelledBy)) || dialog.querySelector("h1, h2, h3, [role='heading']"))?.textContent);
    if (!/^download/i.test(heading)) continue;
    const named = /^['"‘“](.*)['"’”]$/.exec(squash(heading.slice('download'.length)))?.[1];
    if (!title || !named) return 'unknown';
    if (named === title) return 'page';
    // A long title may be cut short with an ellipsis.
    const cut = /^(.+?)\s*(?:…|\.\.\.)$/.exec(named)?.[1];
    return cut && title.startsWith(cut) ? 'page' : 'other';
  }
  return 'unknown';
}

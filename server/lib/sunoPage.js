/**
 * Suno song page (suno.com/song/<id>): in-page steps for the publish recipe.
 * Each function runs INSIDE the page through Playwright's
 * `page.evaluate(fn, arg)`, so it reads only `document` and its argument. The
 * same functions run against fixture documents in the client's DOM tests.
 */

/**
 * Mark the page song's own "More options" button with `data-portos-song-menu`
 * and resolve true, or false when it cannot be told apart from another song's.
 * The page shows other songs' menus too: a cover's "Cover of" song for the song
 * it covers, the Similar / By-artist list, and the playbar. A menu is
 * attributed to the nearest song link or title heading before it in document
 * order, and counts as the page song's only when that is the page's `h1` title
 * or a link to the page's own song. The header menu follows the title; another
 * song's menu follows that song's link, wherever the two sit in the markup.
 * Two menus owned by the title is ambiguous, so it fails rather than guess.
 */
export function markSunoSongMenu(songId) {
  for (const old of document.querySelectorAll('[data-portos-song-menu]')) old.removeAttribute('data-portos-song-menu');
  const wanted = songId.toLowerCase();
  const byTitle = [];
  const byOwnLink = [];
  let owner = null;
  for (const el of document.querySelectorAll("h1, a[href*='/song/'], button[aria-label='More options']")) {
    if (el.tagName === 'BUTTON') {
      if (owner === 'title') byTitle.push(el);
      else if (owner === 'own') byOwnLink.push(el);
    } else if (el.tagName === 'H1') {
      owner = 'title';
    } else {
      const id = (el.getAttribute('href') || '').match(/\/song\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
      owner = id === wanted ? 'own' : 'other';
    }
  }
  if (byTitle.length > 1) return false;
  const own = byTitle[0] || byOwnLink[0];
  if (!own) return false;
  own.setAttribute('data-portos-song-menu', '');
  return true;
}

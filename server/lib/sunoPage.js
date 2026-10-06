/**
 * Suno song page (suno.com/song/<id>): in-page steps for the publish recipe.
 * Each function runs INSIDE the page through Playwright's
 * `page.evaluate(fn, arg)`, so it reads only `document` and its argument. The
 * same functions run against fixture documents in the client's DOM tests.
 */

/**
 * Mark the page song's own "More options" button with `data-portos-song-menu`
 * and resolve true, or false when there is none. The page shows other songs'
 * menus too: a cover's "Cover of" card for the song it covers (rendered above
 * the header's menu), the Similar / By-artist list, and the playbar. A menu
 * whose nearest song card holds just that one menu and links only to other
 * songs belongs to one of those, so it is skipped.
 */
export function markSunoSongMenu(songId) {
  for (const old of document.querySelectorAll('[data-portos-song-menu]')) old.removeAttribute('data-portos-song-menu');
  const menus = [...document.querySelectorAll("button[aria-label='More options']")];
  const idOf = (a) => (a.getAttribute('href') || '').match(/\/song\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
  const own = menus.find((button) => {
    let card = button.parentElement;
    while (card && !card.querySelector('a[href*="/song/"]')) card = card.parentElement;
    if (!card) return true;
    const ids = new Set([...card.querySelectorAll('a[href*="/song/"]')].map(idOf).filter(Boolean));
    const single = card.querySelectorAll("button[aria-label='More options']").length === 1;
    return !(single && !ids.has(songId.toLowerCase()));
  });
  if (!own) return false;
  own.setAttribute('data-portos-song-menu', '');
  return true;
}

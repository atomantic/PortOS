import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { ServerError } from '../lib/errorHandler.js';
import { HIGGSFIELD_VIDEO_ENDPOINT_IDS } from '../lib/higgsfieldVideoModels.js';
import { findUnsupportedHiggsfieldFamilies, parseHiggsfieldCatalog } from '../lib/higgsfieldCatalogScan.js';

export const HIGGSFIELD_CATALOG_URL = 'https://open.higgsfield.ai/pricing';
const TIMEOUT_MS = 20_000;

/** Video families Higgsfield lists that the curated picker does not offer. Public page; no API key or provider call. */
export async function checkHiggsfieldNewModels() {
  const response = await fetchWithTimeout(HIGGSFIELD_CATALOG_URL, { redirect: 'follow' }, TIMEOUT_MS);
  if (!response.ok) throw new ServerError(`Higgsfield catalog returned HTTP ${response.status}`, { status: 502, code: 'HIGGSFIELD_CATALOG_UNAVAILABLE' });
  const entries = parseHiggsfieldCatalog(await response.text());
  // A page that parses to nothing means the markup changed; say so rather than report "no new models".
  if (!entries.length) throw new ServerError('Could not read the Higgsfield model catalog (page format changed)', { status: 502, code: 'HIGGSFIELD_CATALOG_UNREADABLE' });
  return { source: HIGGSFIELD_CATALOG_URL, checkedAt: new Date().toISOString(), unsupported: findUnsupportedHiggsfieldFamilies(entries, HIGGSFIELD_VIDEO_ENDPOINT_IDS) };
}

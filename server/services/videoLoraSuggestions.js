/**
 * Video-LoRA suggestions — a hand-curated quick-install list of HuggingFace
 * video LoRAs (LTX-2 / LTX-Video) so /models/loras surfaces them next to the
 * Civitai image suggestions instead of forcing the user to know the repo id.
 *
 * Why this is separate from civitaiSuggestions.js: video LoRAs live on
 * HuggingFace, not Civitai (see services/loras.js#installFromHuggingface), and
 * the Civitai search iterates Object.values(RUNNER_FAMILIES) — a video family
 * has no Civitai baseModel mapping and would 400. So the two suggestion sources
 * stay decoupled and the route merges them (`video` alongside `curated`/`runners`).
 *
 * Cards are usable from the static curated entry alone; an HF metadata fetch
 * only ENRICHES them (description + preview) and is best-effort — a 404 / rate
 * limit degrades to the static card rather than dropping the suggestion. Cached
 * in-memory with the same 1-hour TTL as the Civitai panel.
 */

import { VIDEO_LORA_FAMILIES } from '../lib/runners.js';
import {
  buildHfResolveUrl,
  detectVideoLoraFamily,
  extractHfCardDescription,
  fetchHuggingfaceModel,
  looksLikeLtxVideo,
  looksLikeMiniMaxH3,
  modelClassificationBlob,
  modelSiblingFilenames,
  pickHfLoraFile,
  searchHuggingfaceLoraModels,
} from '../lib/huggingfaceLora.js';
import { getHfToken } from './hfToken.js';

const TTL_MS = 60 * 60 * 1000; // 1 hour — matches the Civitai suggestion cache.
const DESCRIPTION_MAX_CHARS = 240;

// Hand-picked HuggingFace video LoRAs. `family` is stamped here (HF has no
// Civitai-style baseModel string for the installer to re-derive) so the
// quick-install routes through installFromHuggingface with an explicit family.
const CURATED_VIDEO_LORAS = [
  {
    repo: 'fal/ltx2.3-audio-reactive-lora',
    file: 'ltx2.3_audio_reactive_lora_v2.safetensors',
    family: VIDEO_LORA_FAMILIES.LTX_VIDEO,
    name: 'LTX-2.3 Audio Reactive V2',
    note: 'Improved beat response for LTX-2.3 audio-conditioned renders. Use music as motion guidance; PortOS keeps generated vocals disabled.',
  },
  {
    repo: 'KennethFal/vh5tape-vhs-lora-minimax-h3',
    file: 'vh5tape.safetensors',
    family: VIDEO_LORA_FAMILIES.MINIMAX_H3,
    name: 'VH5 VHS Tape (MiniMax H3)',
    note: 'Retro 1980s VHS look — tracking artifacts, tape grain, and CRT color for MiniMax H3 renders.',
  },
];

const now = () => Date.now();

// HF cards rarely carry a single canonical preview; try the few fields that
// sometimes hold one and fall back to null (the card shows a placeholder).
const pickHfPreview = (model) => {
  const card = model?.cardData;
  if (typeof card?.thumbnail === 'string' && card.thumbnail.trim()) return card.thumbnail.trim();
  return null;
};

// Build one suggestion card from a curated entry. `model` is the HF metadata
// (or null when the fetch failed) — the card is fully functional without it.
const buildCard = (entry, model) => {
  const description = extractHfCardDescription(model, DESCRIPTION_MAX_CHARS);
  return {
    source: 'huggingface',
    repo: entry.repo,
    file: entry.file || null,
    name: entry.name || (entry.repo.split('/')[1] || entry.repo),
    note: entry.note || '',
    description,
    runnerFamily: entry.family,
    previewImageUrl: pickHfPreview(model),
    hfUrl: `https://huggingface.co/${entry.repo}`,
    // The same value /api/loras/install/huggingface accepts — the UI passes it
    // back without re-deriving, mirroring the Civitai card's installUrl.
    installUrl: `https://huggingface.co/${entry.repo}`,
  };
};

let cache = null; // { fetchedAt: number, items: card[] }

const fetchCards = async ({ fetchImpl }) => {
  const token = (await getHfToken().catch(() => null)) || '';
  return Promise.all(CURATED_VIDEO_LORAS.map(async (entry) => {
    const model = await fetchHuggingfaceModel(entry.repo, { token, fetchImpl })
      .catch((err) => {
        console.log(`⚠️ Video LoRA suggestion ${entry.repo} metadata fetch failed: ${err?.message || err}`);
        return null;
      });
    return buildCard(entry, model);
  }));
};

// Public API — returns the curated video-LoRA cards. Never throws on a partial
// HF failure; on a total failure it serves the previous (stale) cache or the
// static cards so the panel always has something to show.
export const getVideoSuggestions = async ({ fetchImpl, force = false } = {}) => {
  if (!force && cache && now() - cache.fetchedAt < TTL_MS) return cache.items;
  const items = await fetchCards({ fetchImpl }).catch((err) => {
    console.log(`⚠️ Video LoRA suggestions fetch failed: ${err?.message || err}`);
    return cache?.items || CURATED_VIDEO_LORAS.map((entry) => buildCard(entry, null));
  });
  cache = { fetchedAt: now(), items };
  return items;
};

// ---------------------------------------------------------------------------
// Searchable video-LoRA catalog (#6500) — live keyword/author search across
// ALL of HuggingFace, not just the curated two-entry list above. Two-phase:
//
//   1. `searchHuggingfaceLoraModels()` hits HF's lightweight list-search endpoint
//      (id + tags, no siblings/cardData) — cheap, and already narrowed with
//      `filter=lora`. A quick classification pass over THAT payload (repo id
//      + tags only) drops anything that plainly isn't LTX/H3 before spending
//      a real request on it.
//   2. Only the survivors get a full `fetchHuggingfaceModel()` fetch (bounded
//      to the page size — never more than `limit` repos per search), which
//      carries `cardData.base_model` and `siblings` — the two fields the
//      quick pass can't see. Re-classify from that full payload (the tags-only
//      guess is provisional) and reject anything with zero `.safetensors`
//      siblings (a base checkpoint or a non-adapter repo, not an installable
//      LoRA) instead of guessing from the largest file.
//
// Cached per (family, query, author, cursor) for a short TTL — long enough to
// absorb repeat page loads and a user re-opening the same search, short
// enough that a fresh HF upload shows up soon. Entries are evicted oldest-
// first past SEARCH_CACHE_MAX_ENTRIES so an unbounded stream of distinct
// queries can't grow the process's memory without limit.
const SEARCH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEARCH_CACHE_MAX_ENTRIES = 40;
const SEARCH_PAGE_LIMIT_DEFAULT = 12;
const SEARCH_PAGE_LIMIT_MAX = 24;
const SEARCH_LIST_TIMEOUT_MS = 10000; // the one list-search request
const SEARCH_METADATA_TIMEOUT_MS = 8000; // PER repo metadata fetch — one slow repo must not stall the page

const VIDEO_PREVIEW_RE = /\.(mp4|webm|mov)$/i;

// searchCache: "<family>::<query>::<author>::<cursor>" -> { fetchedAt, result }
const searchCache = new Map();

const searchCacheKey = ({ family, query, author, cursor }) =>
  `${family || 'all'}::${query || ''}::${author || ''}::${cursor || ''}`;

const rememberSearch = (key, result) => {
  searchCache.set(key, { fetchedAt: now(), result });
  if (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    // Map preserves insertion order — the first key is the oldest entry.
    searchCache.delete(searchCache.keys().next().value);
  }
};

// `family` is either a specific VIDEO_LORA_FAMILIES value or falsy/'all' for
// "any recognized video family". `candidateFamily` is null when the repo
// doesn't classify as a video LoRA at all — never a match regardless of filter.
const matchesRequestedFamily = (family, candidateFamily) => {
  if (!candidateFamily) return false;
  if (!family || family === 'all') return true;
  return candidateFamily === family;
};

// Cheap family guess from the list-search payload alone (repo id + tags —
// no cardData.base_model, no siblings). Used only to decide which candidates
// are worth a full metadata fetch; the real verdict comes from
// detectVideoLoraFamily() against that full response.
const guessFamilyFromListEntry = (item) => {
  const blob = modelClassificationBlob({ repo: item?.id, model: { tags: item?.tags } });
  if (looksLikeMiniMaxH3(blob)) return VIDEO_LORA_FAMILIES.MINIMAX_H3;
  if (looksLikeLtxVideo(blob)) return VIDEO_LORA_FAMILIES.LTX_VIDEO;
  return null;
};

// A sibling that looks like a rendered example clip — best-effort, absent on
// most repos. Returned as a `resolve` URL exactly like the download link, so
// the client can play it on user interaction only (no autoplay).
const pickHfPreviewVideo = (repo, model) => {
  const match = modelSiblingFilenames(model).find((f) => VIDEO_PREVIEW_RE.test(f));
  return match ? buildHfResolveUrl(repo, 'main', match) : null;
};

// Build one search-result card. Unlike the curated cards above, `file` is a
// best-effort RECOMMENDATION (pickHfLoraFile's heuristic) — `files` carries
// every eligible `.safetensors` sibling so the UI can let the user pick a
// different one instead of PortOS silently guessing on a multi-adapter repo.
const buildSearchCard = ({ repo, item, model, family, files }) => {
  const recommendedFile = pickHfLoraFile(model, null, null);
  const previewVideoUrl = pickHfPreviewVideo(repo, model);
  const previewImageUrl = pickHfPreview(model);
  return {
    source: 'huggingface',
    repo,
    revision: 'main',
    file: recommendedFile,
    files: files.map((file) => ({ file, recommended: file === recommendedFile })),
    name: repo.split('/')[1] || repo,
    description: extractHfCardDescription(model, DESCRIPTION_MAX_CHARS),
    runnerFamily: family,
    downloads: typeof item?.downloads === 'number' ? item.downloads : null,
    likes: typeof item?.likes === 'number' ? item.likes : null,
    previewImageUrl,
    previewVideoUrl,
    previewType: previewVideoUrl ? 'video' : (previewImageUrl ? 'image' : null),
    hfUrl: `https://huggingface.co/${repo}`,
    // Bare repo URL — the client sends `file` alongside it, exactly like the
    // curated cards' install call, rather than encoding the file into the URL.
    installUrl: `https://huggingface.co/${repo}`,
  };
};

// Fetch + classify one search candidate. Returns null (never throws) on any
// per-repo failure — a single bad/unreachable repo must not fail the whole
// page of results.
const buildSearchResult = async (item, { family, token, fetchImpl }) => {
  const repo = item?.id;
  if (!repo) return null;
  const model = await fetchHuggingfaceModel(repo, { token, fetchImpl, signal: AbortSignal.timeout(SEARCH_METADATA_TIMEOUT_MS) })
    .catch((err) => {
      console.log(`⚠️ Video LoRA search metadata fetch failed for ${repo}: ${err?.message || err}`);
      return null;
    });
  if (!model) return null;
  // Re-classify from the FULL card — the list-level guess is provisional; a
  // repo whose tags looked like a match can still turn out unrelated (or vice
  // versa) once cardData.base_model is in hand.
  const confirmedFamily = detectVideoLoraFamily({ repo, model });
  if (!matchesRequestedFamily(family, confirmedFamily)) return null;
  const files = modelSiblingFilenames(model).filter((f) => /\.safetensors$/i.test(f));
  // No .safetensors sibling → a base checkpoint or a non-adapter repo, not an
  // installable LoRA. Reject rather than guessing from the file list.
  if (!files.length) return null;
  return buildSearchCard({ repo, item, model, family: confirmedFamily, files });
};

/**
 * Live (short-cached) search across all of HuggingFace for LTX-Video /
 * MiniMax H3 LoRAs. Backs the /models/loras video search box + family filter
 * + "Load more" pagination.
 *
 * `family`: a VIDEO_LORA_FAMILIES value, or null/'all' for both.
 * `query`: keyword — HF matches it against the repo id/name, so pasting an
 *   exact `org/name` repository also works as an exact-repo search.
 * `author`: HF username/org, filtered server-side by HF itself.
 * `cursor`: the previous page's `nextCursor` (opaque) to page forward.
 *
 * Returns `{ family, query, author, items, nextCursor }`. Throws (uncached)
 * on a failed list-search request — the UI surfaces that as a retryable
 * error, matching searchLorasInFamily's Civitai-search contract. A per-repo
 * metadata failure is swallowed and just drops that one candidate.
 */
export const searchVideoLoras = async ({ family = null, query = '', author = '', cursor = null, limit = SEARCH_PAGE_LIMIT_DEFAULT, fetchImpl, force = false } = {}) => {
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  const trimmedAuthor = typeof author === 'string' ? author.trim() : '';
  const boundedLimit = Math.max(1, Math.min(SEARCH_PAGE_LIMIT_MAX, limit || SEARCH_PAGE_LIMIT_DEFAULT));
  const cacheKey = searchCacheKey({ family, query: trimmedQuery, author: trimmedAuthor, cursor });
  const cached = searchCache.get(cacheKey);
  if (!force && cached && now() - cached.fetchedAt < SEARCH_TTL_MS) return cached.result;

  const token = (await getHfToken().catch(() => null)) || '';
  const { items, nextCursor } = await searchHuggingfaceLoraModels({
    query: trimmedQuery,
    author: trimmedAuthor,
    limit: boundedLimit,
    cursor,
    token,
    fetchImpl,
    signal: AbortSignal.timeout(SEARCH_LIST_TIMEOUT_MS),
  });

  // Cheap pre-filter on the list payload bounds the metadata fan-out to at
  // most one fetch per candidate that's actually worth checking — never more
  // than the page size itself.
  const candidates = items.filter((item) => matchesRequestedFamily(family, guessFamilyFromListEntry(item)));
  const built = await Promise.all(candidates.map((item) => buildSearchResult(item, { family, token, fetchImpl })));

  const result = {
    family: family || 'all',
    query: trimmedQuery,
    author: trimmedAuthor,
    items: built.filter(Boolean),
    nextCursor: nextCursor || null,
  };
  rememberSearch(cacheKey, result);
  return result;
};

// Test seam — clear both caches between tests.
export const _resetVideoSuggestionsCache = () => { cache = null; searchCache.clear(); };

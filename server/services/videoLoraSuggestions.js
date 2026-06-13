/**
 * Video-LoRA suggestions — a hand-curated quick-install list of HuggingFace
 * video LoRAs (LTX-2 / LTX-Video) so /media/loras surfaces them next to the
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
import { extractHfCardDescription, fetchHuggingfaceModel } from '../lib/huggingfaceLora.js';
import { getHfToken } from '../lib/hfToken.js';

const TTL_MS = 60 * 60 * 1000; // 1 hour — matches the Civitai suggestion cache.
const DESCRIPTION_MAX_CHARS = 240;

// Hand-picked HuggingFace video LoRAs. `family` is stamped here (HF has no
// Civitai-style baseModel string for the installer to re-derive) so the
// quick-install routes through installFromHuggingface with an explicit family.
const CURATED_VIDEO_LORAS = [
  {
    repo: 'fal/ltx2.3-audio-reactive-lora',
    family: VIDEO_LORA_FAMILIES.LTX_VIDEO,
    name: 'LTX-2.3 Audio Reactive',
    note: 'Drives camera and scene energy from an audio track — built for LTX-2 (ltx2) video renders.',
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

// Test seam — clear the cache between tests.
export const _resetVideoSuggestionsCache = () => { cache = null; };

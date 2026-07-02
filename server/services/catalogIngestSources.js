/**
 * Catalog ingest sources — URL / file / voice-memo / brain-bridge entry points.
 *
 * Each source produces raw text + a scrap with a typed `source_kind`, then
 * hands off to the SAME extraction pipeline the textarea-paste flow uses
 * (`extractIngredients`). So they emit identical `catalog:extract:progress`
 * frames and the client lands on the same paste→review→commit UI.
 *
 *   url          — fetch the page via the browser service, pull main text,
 *                  source_kind 'url', metadata { url, title }.
 *   file         — text already read client-side (.txt/.md), source_kind 'file',
 *                  metadata { filename, mime }.
 *   voice-memo   — base64 WAV → Whisper transcript, audio persisted under
 *                  data/audio to mint a media_key, source_kind 'voice-memo',
 *                  metadata { mediaKey, mimeType, durationApproxMs? }.
 *   brain-bridge — an existing brain record (idea / memory / project / admin /
 *                  person), its prose folded into one rawText block,
 *                  source_kind 'brain-bridge', metadata { brainType, brainId,
 *                  brainTitle, brainTags }. This is the ingestion bridge that
 *                  makes the catalog the universal sink for captured thoughts.
 *
 * Keeping this orchestration out of the route handlers lets the unit tests
 * mock the network/Whisper boundaries without spinning up Express.
 */

import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import * as catalogDB from './catalogDB.js';
import * as brainStorage from './brainStorage.js';
import { extractIngredientsForScrap } from './catalogExtraction.js';
import { transcribe } from './voice/stt.js';
import {
  navigateToUrlPinned,
  evaluateOnPage,
} from './browserService.js';
import { lookup } from 'dns/promises';
import { PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import { isSafeIngestUrl, isBlockedIngestHost } from '../lib/catalogValidation.js';

// Cap fetched/transcribed bodies at the scrap column boundary (the Zod
// rawText max). A runaway page or a multi-hour memo can't blow past the DB.
const RAW_TEXT_MAX = 2_000_000;

// Browser settle delay between navigate and innerText read. The CDP
// `/json/new` resolves as soon as the tab exists, not when the DOM is ready,
// so a same-tick innerText read returns an empty/loading body.
const PAGE_SETTLE_MS = 2_500;

const clampText = (s) => (typeof s === 'string' ? s.slice(0, RAW_TEXT_MAX) : '');


/**
 * Shared tail for every source: create a typed scrap and run the SAME
 * extraction pipeline the textarea-paste flow uses, returning `{ scrap, draft }`
 * (the exact shape the existing /scraps/:id/extract route returns, so the
 * client review flow is identical). The three source functions differ only in
 * how they PRODUCE rawText / title / metadata; this codifies the "one pipeline"
 * contract the module header describes. `log` receives the created scrap.
 */
async function createScrapAndExtract({ title, rawText, sourceKind, metadata, providerOverride, log }) {
  // Chunk long pastes identically to the textarea flow — createChunkedScrap
  // returns the PARENT scrap and extractIngredientsForScrap unions the children.
  const scrap = await catalogDB.createChunkedScrap({ title, rawText, sourceKind, metadata });
  const draft = await extractIngredientsForScrap({ scrapId: scrap.id, providerOverride });
  if (log) console.log(log(scrap));
  return { scrap, draft };
}

/**
 * Full SSRF gate for an ingest URL: scheme + blocked-literal check (sync), AND
 * a DNS resolve so a hostname whose A record points at a blocked address
 * (cloud metadata / loopback / link-local) is rejected too. Applied to BOTH the
 * request-body URL and the post-redirect landed URL — a redirect to such a
 * hostname must be caught the same way as the first hop. (Residual TOCTOU —
 * Chrome re-resolves independently — is acceptable on a single-user private
 * network; this closes the realistic record-points-at-metadata vector.)
 */
async function assertIngestUrlSafe(target) {
  if (!isSafeIngestUrl(target)) {
    throw new Error('refusing to ingest a non-http(s) or loopback/link-local URL');
  }
  const { hostname } = new URL(target);
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (!isIpLiteral) {
    const resolved = await lookup(hostname).catch(() => null);
    if (resolved?.address && isBlockedIngestHost(resolved.address)) {
      throw new Error('refusing to ingest a host that resolves to a blocked (loopback/link-local) address');
    }
  }
}

/**
 * Fetch a URL through the browser service and return its main text + title.
 * Uses CDP (the same headed/headless Chrome the rest of PortOS drives) so
 * JS-rendered pages and login-walled content the user is already signed into
 * resolve correctly — a bare `fetch()` would only see the server-rendered
 * HTML shell of an SPA.
 *
 * SSRF pin: Chrome re-resolves DNS independently of our pre-check, so a rebinding
 * DNS answer could steer Chrome's connection to a blocked address after
 * `assertIngestUrlSafe` vetted the hostname (a TOCTOU). `navigateToUrlPinned`
 * closes that window by verifying, against Chrome's OWN reported
 * `remoteIPAddress`, that EVERY main-frame hop — the initial navigation, each
 * HTTP redirect, AND any client-side navigation during the `settleMs` window
 * before the DOM is read — connected to an allowed address, refusing (and
 * tearing the tab down) otherwise. The `isBlockedIngestHost` blocklist is the
 * SAME criterion `assertIngestUrlSafe` vets with, so the pin and the pre-check
 * agree. The pin owns the settle wait, so there is no separate stale-DNS re-vet
 * (which would itself be rebindable) after it returns.
 *
 * Returns `{ text, title, finalUrl }`. Throws when the browser can't reach
 * the page or extracts nothing usable, so the route surfaces a clean 4xx/5xx.
 */
export async function fetchUrlMainText(url, { settleMs = PAGE_SETTLE_MS } = {}) {
  await assertIngestUrlSafe(url);

  // Navigate in a fresh tab and PIN: verify Chrome's actual per-hop connection
  // IP is not a blocked (loopback / link-local / metadata) address for the
  // initial nav, every redirect, and any client-side nav during the settle
  // window — closing the rebinding gap between our dns.lookup above and Chrome's
  // own resolution. Fails closed (tab torn down, throws) on any disallowed hop.
  // The pin waits out settleMs internally, so the DOM is ready + fully pinned
  // by the time it returns and we read.
  const page = await navigateToUrlPinned(url, {
    verifyRemoteIp: (ip) => !isBlockedIngestHost(ip),
    settleMs,
  });

  // Prefer the page's own <article>/<main> if present (skips nav/footer
  // chrome), falling back to document body text. Runs in the page; returns a
  // plain string so evaluateOnPage's returnByValue marshals it cleanly.
  const expression = `(() => {
    const pick = document.querySelector('article') || document.querySelector('main') || document.body;
    const title = (document.title || '').trim();
    const text = (pick && pick.innerText ? pick.innerText : '').trim();
    return JSON.stringify({ title, text });
  })()`;
  const raw = await evaluateOnPage(page, expression);
  const parsed = raw ? safeJSONParse(raw, null) : null;
  const text = clampText(parsed?.text || '');
  if (!text.trim()) throw new Error('no readable text extracted from page');
  return { text, title: parsed?.title || page.title || '', finalUrl: page.url || url };
}

/**
 * Ingest from a URL: fetch + extract main text, create a 'url' scrap, run the
 * extraction pipeline. Returns `{ scrap, draft }` — same shape as the existing
 * /scraps/:id/extract route so the client review flow is unchanged.
 */
export async function ingestFromUrl({ url, providerOverride, settleMs } = {}) {
  const { text, title, finalUrl } = await fetchUrlMainText(url, settleMs !== undefined ? { settleMs } : {});
  return createScrapAndExtract({
    title: title || finalUrl,
    rawText: text,
    sourceKind: 'url',
    metadata: { url: finalUrl, title: title || null },
    providerOverride,
    log: (s) => `🌐 Catalog URL ingest: ${finalUrl} → scrap ${s.id} (${text.length} chars)`,
  });
}

/**
 * Ingest from an uploaded text file. The client reads .txt/.md text locally
 * and posts it with the original filename/mime; we record provenance in scrap
 * metadata and run the pipeline.
 */
export async function ingestFromFile({ text, filename, mime, providerOverride } = {}) {
  const rawText = clampText(text);
  if (!rawText.trim()) throw new Error('file contained no extractable text');
  return createScrapAndExtract({
    title: filename,
    rawText,
    sourceKind: 'file',
    metadata: { filename, mime: mime || null },
    providerOverride,
    log: (s) => `📄 Catalog file ingest: ${filename} → scrap ${s.id} (${rawText.length} chars)`,
  });
}

/**
 * Persist a recorded memo's audio under data/audio and return its filename —
 * the `media_key` the catalog uses to reference media without storing bytes
 * in the scrap. Mirrors the audio path PATHS.audio is already used for.
 */
async function persistVoiceMemoAudio(audioBuffer, mimeType) {
  // WAV is the only format the client encodes (whisper.cpp accepts WAV only),
  // so default the extension to .wav; honor an explicit webm/mp3 mime if the
  // client ever sends a pre-encoded blob.
  const ext = mimeType?.includes('webm') ? 'webm' : mimeType?.includes('mpeg') ? 'mp3' : 'wav';
  const mediaKey = `voice-memo-${randomUUID()}.${ext}`;
  await ensureDir(PATHS.audio);
  await writeFile(join(PATHS.audio, mediaKey), audioBuffer);
  return mediaKey;
}

/**
 * Ingest from a recorded voice memo: decode base64 WAV → Whisper transcript →
 * persist audio (mint media_key) → 'voice-memo' scrap → pipeline. The audio
 * media_key rides in scrap metadata so a later commit can attach it to the
 * resulting ingredient via the media-refs table.
 *
 * `deps` lets tests inject a fake transcriber / persister without a running
 * Whisper server or touching disk.
 */
export async function ingestFromVoice(
  { audioBase64, mimeType = 'audio/wav', title, providerOverride } = {},
  { transcribeFn = transcribe, persistFn = persistVoiceMemoAudio } = {},
) {
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  if (audioBuffer.byteLength === 0) throw new Error('voice memo audio was empty');

  const { text } = await transcribeFn(audioBuffer, { mimeType });
  const transcript = clampText((text || '').trim());
  if (!transcript) throw new Error('voice memo produced an empty transcript');

  // Persist the audio AFTER a successful transcription so a failed/empty memo
  // doesn't litter data/audio with orphan files.
  const mediaKey = await persistFn(audioBuffer, mimeType);

  const { scrap, draft } = await createScrapAndExtract({
    title: title?.trim() || 'Voice memo',
    rawText: transcript,
    sourceKind: 'voice-memo',
    metadata: { mediaKey, mimeType },
    providerOverride,
    log: (s) => `🎙️ Catalog voice ingest: ${mediaKey} → scrap ${s.id} (${transcript.length} chars)`,
  });
  return { scrap, draft, mediaKey };
}

// Supported brain record types → their by-id storage getter. Mirrors
// `CATALOG_BRAIN_INGEST_TYPES` in catalogValidation.js (the route validates the
// type against that enum before we get here; this map is the resolution side).
// We import the leaf `brainStorage` rather than `brain.js` so this stays a pure
// read — no AI/classification side effects ride along.
const BRAIN_INGEST_GETTERS = {
  ideas: brainStorage.getIdeaById,
  memories: brainStorage.getMemoryEntryById,
  projects: brainStorage.getProjectById,
  admin: brainStorage.getAdminById,
  people: brainStorage.getPersonById,
};

/**
 * Fold a brain record's prose into a single ingest-ready text block. Each brain
 * type keeps its body in different fields (an idea's `oneLiner` + `notes`, a
 * memory's `content`, a project/admin's `nextAction` + `notes`, a person's
 * `context` + `followUps`), so map per-type rather than guessing. The record's
 * title/name is prepended as context for the extractor, and any record tags ride
 * along in metadata so the user can keep them on the committed ingredients.
 * Returns `{ title, rawText, tags }`.
 */
export function brainRecordToIngestText(brainType, record) {
  const title = (record?.title || record?.name || '').trim();
  const parts = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) parts.push(v.trim()); };
  switch (brainType) {
    case 'ideas':
      push(record?.oneLiner);
      push(record?.notes);
      break;
    case 'memories':
      push(record?.content);
      break;
    case 'projects':
    case 'admin':
      if (record?.nextAction) push(`Next: ${record.nextAction}`);
      push(record?.notes);
      break;
    case 'people':
      push(record?.context);
      if (Array.isArray(record?.followUps) && record.followUps.length) {
        push(`Follow-ups: ${record.followUps.join('; ')}`);
      }
      break;
    default:
      // Best-effort for any future type the enum admits before this map does.
      for (const k of ['oneLiner', 'content', 'notes', 'context', 'summary', 'description']) {
        push(record?.[k]);
      }
  }
  const body = parts.join('\n\n').trim();
  const rawText = clampText(title ? `${title}\n\n${body}`.trim() : body);
  const tags = Array.isArray(record?.tags) ? record.tags.filter((t) => typeof t === 'string') : [];
  return { title: title || 'Brain entry', rawText, tags };
}

/**
 * Ingest from an existing brain record. Resolves the record by `{ brainType,
 * brainId }`, folds its prose into rawText, and runs the same scrap→extract
 * pipeline as every other source — returning `{ scrap, draft }` so the client
 * lands on the identical review phase. This is the brain → catalog bridge: a
 * captured idea/journal/etc. becomes typed catalog ingredients the user reviews
 * and commits, making the catalog the universal sink for creative atoms.
 */
export async function ingestFromBrain({ brainType, brainId, providerOverride } = {}) {
  const getter = BRAIN_INGEST_GETTERS[brainType];
  if (!getter) throw new Error(`unsupported brain type for catalog ingest: ${brainType}`);
  const record = await getter(brainId);
  if (!record) throw new Error(`brain ${brainType} entry not found: ${brainId}`);
  // rawText is already trimmed by brainRecordToIngestText (and folds in the
  // title), so a falsy check is sufficient to catch a record with no usable
  // text at all (no title AND no body). A title-only record is intentionally
  // ingestible — the user explicitly chose to send it.
  const { title, rawText, tags } = brainRecordToIngestText(brainType, record);
  if (!rawText) throw new Error('brain entry had no text to ingest');
  return createScrapAndExtract({
    title,
    rawText,
    sourceKind: 'brain-bridge',
    metadata: { brainType, brainId, brainTitle: title, brainTags: tags },
    providerOverride,
    log: (s) => `🧠 Catalog brain ingest: ${brainType}/${brainId} → scrap ${s.id} (${rawText.length} chars)`,
  });
}

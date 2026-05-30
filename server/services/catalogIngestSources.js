/**
 * Catalog ingest sources — URL / file / voice-memo entry points.
 *
 * Each source produces raw text + a scrap with a typed `source_kind`, then
 * hands off to the SAME extraction pipeline the textarea-paste flow uses
 * (`extractIngredients`). So they emit identical `catalog:extract:progress`
 * frames and the client lands on the same paste→review→commit UI.
 *
 *   url        — fetch the page via the browser service, pull main text,
 *                source_kind 'url', metadata { url, title }.
 *   file       — text already read client-side (.txt/.md), source_kind 'file',
 *                metadata { filename, mime }.
 *   voice-memo — base64 WAV → Whisper transcript, audio persisted under
 *                data/audio to mint a media_key, source_kind 'voice-memo',
 *                metadata { mediaKey, mimeType, durationApproxMs? }.
 *
 * Keeping this orchestration out of the route handlers lets the unit tests
 * mock the network/Whisper boundaries without spinning up Express.
 */

import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import * as catalogDB from './catalogDB.js';
import { extractIngredients } from './catalogExtraction.js';
import { transcribe } from './voice/stt.js';
import {
  navigateToUrl,
  listCdpPages,
  evaluateOnPage,
} from './browserService.js';
import { lookup } from 'dns/promises';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { isSafeIngestUrl, isBlockedIngestHost } from '../lib/catalogValidation.js';

// Cap fetched/transcribed bodies at the scrap column boundary (the Zod
// rawText max). A runaway page or a multi-hour memo can't blow past the DB.
const RAW_TEXT_MAX = 2_000_000;

// Browser settle delay between navigate and innerText read. The CDP
// `/json/new` resolves as soon as the tab exists, not when the DOM is ready,
// so a same-tick innerText read returns an empty/loading body.
const PAGE_SETTLE_MS = 2_500;

const clampText = (s) => (typeof s === 'string' ? s.slice(0, RAW_TEXT_MAX) : '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared tail for every source: create a typed scrap and run the SAME
 * extraction pipeline the textarea-paste flow uses, returning `{ scrap, draft }`
 * (the exact shape the existing /scraps/:id/extract route returns, so the
 * client review flow is identical). The three source functions differ only in
 * how they PRODUCE rawText / title / metadata; this codifies the "one pipeline"
 * contract the module header describes. `log` receives the created scrap.
 */
async function createScrapAndExtract({ title, rawText, sourceKind, metadata, providerOverride, log }) {
  const scrap = await catalogDB.createScrap({ title, rawText, sourceKind, metadata });
  const draft = await extractIngredients({ rawText, scrapId: scrap.id, providerOverride });
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
 * Returns `{ text, title, finalUrl }`. Throws when the browser can't reach
 * the page or extracts nothing usable, so the route surfaces a clean 4xx/5xx.
 */
export async function fetchUrlMainText(url, { settleMs = PAGE_SETTLE_MS } = {}) {
  await assertIngestUrlSafe(url);

  // `navigateToUrl` opens a fresh tab at the exact URL and returns it; we drive
  // and read that tab below. (Don't call findOrOpenPage first — it would open a
  // SECOND, orphaned tab per ingest, since navigateToUrl never reuses one.)
  const opened = await navigateToUrl(url);
  await sleep(settleMs);

  // Re-list to get the live webSocketDebuggerUrl for the tab we just drove.
  // Match strictly by the id (then the exact url) navigateToUrl returned —
  // never fall back to an arbitrary `pages[0]`, which could be an unrelated
  // open tab and would ingest the wrong (possibly sensitive) page.
  const pages = await listCdpPages();
  const page = pages.find((p) => p.id === opened.id)
    || pages.find((p) => p.url === opened.url);
  if (!page) throw new Error('could not match the navigated tab after navigation (refusing to read an arbitrary tab)');

  // Re-run the FULL gate (scheme + DNS) against the FINAL url before reading the
  // DOM: a server-controlled redirect could have sent Chrome to a blocked
  // target, or to a hostname that itself resolves to one. The first-hop gate
  // doesn't cover the landed page.
  const landedUrl = page.url || opened.url || url;
  await assertIngestUrlSafe(landedUrl);

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
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
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

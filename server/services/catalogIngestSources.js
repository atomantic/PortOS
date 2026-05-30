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
  findOrOpenPage,
  navigateToUrl,
  listCdpPages,
  evaluateOnPage,
} from './browserService.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';

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
  // Open (or reuse a tab already on this host), then navigate to force the
  // exact URL — findOrOpenPage matches by hostname so an existing tab on the
  // same site would otherwise be reused at the wrong path.
  await findOrOpenPage(url).catch(() => null);
  const opened = await navigateToUrl(url);
  await sleep(settleMs);

  // Re-list to get the live webSocketDebuggerUrl for the tab we just drove.
  const pages = await listCdpPages();
  const page = pages.find((p) => p.id === opened.id)
    || pages.find((p) => p.url === opened.url)
    || pages[0];
  if (!page) throw new Error('browser tab not found after navigation');

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
  const scrap = await catalogDB.createScrap({
    title: title || finalUrl,
    rawText: text,
    sourceKind: 'url',
    metadata: { url: finalUrl, title: title || null },
  });
  const draft = await extractIngredients({ rawText: text, scrapId: scrap.id, providerOverride });
  console.log(`🌐 Catalog URL ingest: ${finalUrl} → scrap ${scrap.id} (${text.length} chars)`);
  return { scrap, draft };
}

/**
 * Ingest from an uploaded text file. The client reads .txt/.md text locally
 * and posts it with the original filename/mime; we record provenance in scrap
 * metadata and run the pipeline.
 */
export async function ingestFromFile({ text, filename, mime, providerOverride } = {}) {
  const rawText = clampText(text);
  if (!rawText.trim()) throw new Error('file contained no extractable text');
  const scrap = await catalogDB.createScrap({
    title: filename,
    rawText,
    sourceKind: 'file',
    metadata: { filename, mime: mime || null },
  });
  const draft = await extractIngredients({ rawText, scrapId: scrap.id, providerOverride });
  console.log(`📄 Catalog file ingest: ${filename} → scrap ${scrap.id} (${rawText.length} chars)`);
  return { scrap, draft };
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

  const scrap = await catalogDB.createScrap({
    title: title?.trim() || 'Voice memo',
    rawText: transcript,
    sourceKind: 'voice-memo',
    metadata: { mediaKey, mimeType },
  });
  const draft = await extractIngredients({ rawText: transcript, scrapId: scrap.id, providerOverride });
  console.log(`🎙️ Catalog voice ingest: ${mediaKey} → scrap ${scrap.id} (${transcript.length} chars)`);
  return { scrap, draft, mediaKey };
}

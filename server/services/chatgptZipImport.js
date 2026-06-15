/**
 * ChatGPT ZIP Import Service
 *
 * Ingests the modern multi-file ChatGPT data export (a `.zip`, streamed up
 * whole — no in-memory cap) end to end:
 *
 *   1. Stream-extract the ZIP (`parseZip`) — never decompress the whole archive
 *      into one buffer; members are handled one at a time as they arrive.
 *      - `conversations*.json` + `conversation_asset_file_names.json` are
 *        buffered in memory (small relative to the assets).
 *      - `*.dat` asset files (images / voice audio / PDFs) are each buffered
 *        (so their magic bytes can be sniffed for the real extension) and then
 *        written to the served assets dir (`PATHS.brainImportAssets`) keyed by
 *        their global asset id, falling back to the friendly name in the
 *        asset-name map. `chat.html` and other bulky members are drained
 *        without buffering. A running `MAX_TOTAL_BUFFERED_BYTES` budget caps
 *        the aggregate held in memory so a pathological export can't OOM the
 *        process (the per-asset hold is bounded; true per-asset streaming to
 *        disk is tracked in PLAN.md).
 *   2. Build a `pointer -> { url, name, mime }` resolver so transcript rendering
 *      can inline `![](url)` images and `[🔊 audio](url)` / `[📎 file](url)`
 *      links pointing at the extracted assets.
 *   3. Parse + import via the shared `chatgptImport` service, passing the
 *      resolver so every conversation's transcript embeds its assets.
 *
 * Both the legacy single-`conversations.json` JSON path (browser-parsed) and
 * this ZIP path converge on the same `parseExport`/`importConversations` — the
 * only difference is the `assetResolver`.
 */

import { createReadStream } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { Writable } from 'stream';
import { PATHS, getMimeType } from '../lib/fileUtils.js';
import { parseZip } from '../lib/zipStream.js';
import { parseExport, importConversations, assetPointerId } from './chatgptImport.js';
import { ServerError } from '../lib/errorHandler.js';

// Cap an individual buffered member (JSON shard or `.dat` asset). The largest
// conversation shard in a real export is ~6 MB and assets run KB–few MB; 100 MB
// is a generous per-member backstop against a malicious zip claiming one member
// is enormous.
const MAX_MEMBER_BYTES = 100 * 1024 * 1024;

// Cap the AGGREGATE bytes held in memory at once. Asset buffers accumulate in
// `pendingAssets` until the stream closes (the asset-name map may arrive after
// the `.dat` members, so we can't resolve+flush each in isolation), so without
// an aggregate ceiling a pathological multi-GB export — the route allows up to
// 2 GB — could exhaust the heap before the write loop runs. 1 GB comfortably
// holds any real export's assets; beyond that we fail fast rather than OOM.
// (True per-asset stream-to-disk would remove this ceiling — tracked in PLAN.md.)
const MAX_TOTAL_BUFFERED_BYTES = 1024 * 1024 * 1024;

// Magic-byte sniffers — `.dat` files carry no extension, so we detect the real
// type from the leading bytes and give the served file a correct extension.
// Order matters (WebP's RIFF prefix is also used by WAV, so check the form id).
const sniffExtension = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') {
    const form = buf.slice(8, 12).toString('ascii');
    if (form === 'WEBP') return '.webp';
    if (form === 'WAVE') return '.wav';
    return null;
  }
  // ID3-tagged or raw MPEG audio.
  if (buf.slice(0, 3).toString('ascii') === 'ID3') return '.mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';
  return null;
};

// Extensions we'll trust from the export-controlled friendly name when magic-
// byte sniffing fails. These are inert document/media types the static mount
// serves harmlessly. Active-content types (.html/.svg/.xml/.js/...) are
// DELIBERATELY excluded: an attachment named `x.html` would otherwise be
// written under /data/brain-imports/ and served inline with an executable
// content type, and the viewer links to those same-origin assets — clicking
// one would run script in PortOS's origin. Anything not on this list falls
// back to `.bin` (served as application/octet-stream — download, never inline).
const INERT_FALLBACK_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.wav', '.mp3', '.m4a', '.ogg', '.mp4', '.webm', '.mov',
  '.txt', '.md', '.csv', '.json',
]);

// Friendly-name → extension fallback when magic-byte sniffing comes up empty.
// Returns null for anything not on the inert allowlist (caller uses `.bin`),
// so an export can never steer the served extension to an active-content type.
const extFromName = (name) => {
  const m = String(name || '').match(/\.([a-z0-9]{1,5})$/i);
  if (!m) return null;
  const ext = `.${m[1].toLowerCase()}`;
  return INERT_FALLBACK_EXTS.has(ext) ? ext : null;
};

const IS_DAT = (path) => path.endsWith('.dat');
const IS_CONVO_JSON = (path) => /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(path);
const IS_ASSET_NAME_MAP = (path) => /(?:^|\/)conversation_asset_file_names\.json$/i.test(path);

// A `.dat` member's asset id is its basename without extension. Conversations
// reference assets as `file-service://file-XXX` / `sediment://file_HASH`, both
// of which `assetPointerId()` reduces to that same bare id.
const datAssetId = (path) => path.replace(/^.*\//, '').replace(/\.dat$/i, '');

// `parseZip` entries aren't readable streams — they expose `.pipe(dest)` /
// `.autodrain()`. Pipe the entry into a size-capped collecting Writable and
// resolve with the concatenated buffer.
const collect = (entry, max) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      size += chunk.length;
      if (size > max) { cb(new Error(`ZIP member exceeds ${max} byte limit`)); return; }
      chunks.push(chunk);
      cb();
    }
  });
  sink.on('finish', () => resolve(Buffer.concat(chunks)));
  sink.on('error', reject);
  entry.pipe(sink);
});

/**
 * Stream-extract a ChatGPT export ZIP at `zipPath`.
 *
 * Returns:
 *   {
 *     conversationFiles: Array<parsed JSON>,   // each conversations*.json
 *     assets: Map<assetId, { url, name, mime, file }>,
 *     assetNameMap: Record<datFilename, friendlyName>,
 *     stats: { assetCount, conversationFileCount }
 *   }
 *
 * Assets are written to `data/brain/imports/assets/<assetId><ext>` and surfaced
 * at `/data/brain-imports/<assetId><ext>`.
 */
export async function extractChatgptZip(zipPath, { assetDir = PATHS.brainImportAssets } = {}) {
  await mkdir(assetDir, { recursive: true });

  const convoBuffers = [];          // { path, buffer }
  let assetNameMap = {};
  // assetId -> { datPath, buffer } collected during the stream; we resolve
  // extensions + write files after, because the name map may arrive after the
  // .dat members (member order in the ZIP isn't guaranteed).
  const pendingAssets = new Map();
  let totalBuffered = 0;            // running aggregate-memory guard (see MAX_TOTAL_BUFFERED_BYTES)

  await new Promise((resolve, reject) => {
    let settled = false;
    const src = createReadStream(zipPath);
    const parser = parseZip();
    // On any error/settle, tear down both streams. Rejecting the Promise alone
    // doesn't stop ingestion — the read stream keeps flowing into the parser and
    // collect() keeps buffering members, so a charge() overflow would otherwise
    // exhaust the heap *after* the budget guard already fired, defeating it.
    const settle = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      if (fn === reject) { src.destroy(); parser.destroy?.(); }
      fn(arg);
    };
    const onErr = settle(reject);
    const inFlight = [];
    // Charge buffered bytes against the aggregate budget the moment they land,
    // failing fast before the heap is exhausted (collect()'s per-member cap
    // alone can't bound the sum across hundreds of assets held until flush).
    const charge = (buf) => {
      totalBuffered += buf.length;
      if (totalBuffered > MAX_TOTAL_BUFFERED_BYTES) {
        throw new Error(`ChatGPT export exceeds the ${MAX_TOTAL_BUFFERED_BYTES}-byte in-memory budget`);
      }
      return buf;
    };

    src
      .on('error', onErr)
      .pipe(parser)
      .on('entry', (entry) => {
        const { path } = entry;
        if (IS_ASSET_NAME_MAP(path)) {
          inFlight.push(collect(entry, MAX_MEMBER_BYTES)
            .then(charge)
            .then((buf) => { assetNameMap = JSON.parse(buf.toString('utf8')); })
            .catch(onErr));
        } else if (IS_CONVO_JSON(path)) {
          inFlight.push(collect(entry, MAX_MEMBER_BYTES)
            .then(charge)
            .then((buf) => { convoBuffers.push({ path, buffer: buf }); })
            .catch(onErr));
        } else if (IS_DAT(path)) {
          // Buffer the asset bytes. Asset `.dat` files in real exports are
          // individual media files (KB–few MB); collecting one at a time lets
          // us sniff magic bytes for the extension. The aggregate `charge`
          // guard bounds the sum held across all assets until the write loop.
          inFlight.push(collect(entry, MAX_MEMBER_BYTES)
            .then(charge)
            .then((buf) => { pendingAssets.set(datAssetId(path), { datPath: path, buffer: buf }); })
            .catch(onErr));
        } else {
          // chat.html, export_manifest.json, library_files.json, user.json, etc.
          // — not needed for the transcript+asset import. Drain without buffering.
          entry.autodrain();
        }
      })
      .on('close', () => { Promise.all(inFlight).then(settle(resolve), onErr); })
      .on('error', onErr);
  });

  // Resolve each buffered asset's extension + write it to the served dir,
  // dropping each buffer from the Map as it's flushed so the held memory falls
  // as the loop progresses rather than staying at its peak until the end.
  const assets = new Map();
  for (const [assetId, { datPath, buffer }] of pendingAssets) {
    const friendlyName = assetNameMap[`${assetId}.dat`] || assetNameMap[datPath] || null;
    const ext = sniffExtension(buffer) || extFromName(friendlyName) || '.bin';
    const fileName = `${assetId}${ext}`;
    const filePath = `${assetDir}/${fileName}`;
    // eslint-disable-next-line no-await-in-loop -- sequential write keeps peak
    // disk/IO bounded; an export has a few hundred assets, not millions.
    await writeFile(filePath, buffer);
    pendingAssets.delete(assetId);   // release the buffer for GC
    assets.set(assetId, {
      url: `/data/brain-imports/${fileName}`,
      name: friendlyName || fileName,
      mime: getMimeType(ext),
      file: fileName,
    });
  }

  const conversationFiles = [];
  for (const { path, buffer } of convoBuffers) {
    // A truncated/corrupt export (realistic for a partial download) makes
    // JSON.parse throw HERE — after the asset files were already written to the
    // served dir. Clean those orphans up before surfacing a clean 400, otherwise
    // the throw escapes extractChatgptZip and importChatgptZip never reaches its
    // cleanupExtractedAssets() path.
    try {
      conversationFiles.push(JSON.parse(buffer.toString('utf8')));
    } catch {
      await cleanupExtractedAssets(assets, assetDir);
      throw new ServerError(`${path} is not valid JSON — the ChatGPT export looks truncated or corrupt.`, {
        status: 400,
        code: 'INVALID_CHATGPT_EXPORT',
      });
    }
  }

  return {
    conversationFiles,
    assets,
    assetNameMap,
    stats: {
      assetCount: assets.size,
      conversationFileCount: conversationFiles.length,
    },
  };
}

/**
 * Build an `assetResolver(pointer)` closure over an extracted-assets Map.
 * Resolves `file-service://`, `sediment://`, and bare-id pointers to the
 * served asset descriptor, or null when the pointer's asset wasn't in the
 * export (ChatGPT omits expired/server-side-only assets — normal, not an error).
 */
export function makeAssetResolver(assets) {
  return (pointer) => {
    if (!pointer) return null;
    const id = assetPointerId(pointer);
    return assets.get(id) || null;
  };
}

// Remove the asset files extractChatgptZip() wrote to the served dir. Called on
// any FAILED import path: extraction writes assets to `/data/brain-imports/`
// before conversations are validated, so a ZIP with assets but no valid
// conversation shards (corrupt/wrong upload) would otherwise leave orphaned
// served files behind, and repeated bad uploads could fill the disk.
async function cleanupExtractedAssets(assets, assetDir = PATHS.brainImportAssets) {
  await Promise.all(
    [...assets.values()].map((a) => unlink(`${assetDir}/${a.file}`).catch(() => {}))
  );
}

/**
 * Full ZIP-import pipeline: extract → resolve assets → parse → import.
 * `zipPath` is a temp file (the streamed multipart upload); the caller owns
 * unlinking it. Returns the `importConversations` result augmented with asset
 * stats, plus the parsed preview summary. On any failure the extracted assets
 * are removed so a bad upload doesn't leave orphaned files under the served dir.
 */
export async function importChatgptZip(zipPath, { tags, skipEmpty } = {}) {
  const { conversationFiles, assets, stats } = await extractChatgptZip(zipPath);

  if (conversationFiles.length === 0) {
    await cleanupExtractedAssets(assets);
    return { ok: false, error: 'No conversations*.json files found in the ZIP. Is this a ChatGPT data export?' };
  }

  const assetResolver = makeAssetResolver(assets);
  const parsed = parseExport({ conversationFiles }, { assetResolver });
  if (!parsed.ok) {
    await cleanupExtractedAssets(assets);
    return parsed;
  }

  const result = await importConversations(parsed, { tags, skipEmpty });
  return {
    ...result,
    summary: parsed.summary,
    assetStats: stats,
  };
}

export const __test = { sniffExtension, extFromName, datAssetId, makeAssetResolver, cleanupExtractedAssets };

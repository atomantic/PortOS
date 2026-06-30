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
 *      - `*.dat` asset files (images / voice audio / PDFs) are **streamed
 *        straight to a temp file** in the served assets dir
 *        (`PATHS.brainImportAssets`) as they arrive — only the leading bytes are
 *        held to sniff the real extension, so peak RAM stays bounded to one chunk
 *        no matter how large the export is. After the stream closes (the
 *        asset-name map may arrive after the `.dat` members) each temp file is
 *        renamed to its final `<assetId><ext>` served name, keyed by the global
 *        asset id and falling back to the friendly name in the asset-name map
 *        for the extension when magic-byte sniffing comes up empty. `chat.html`
 *        and other bulky members are drained without buffering.
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

import { createReadStream, createWriteStream } from 'fs';
import { rename, unlink } from 'fs/promises';
import { Writable } from 'stream';
import { PATHS, getMimeType, ensureDir } from '../lib/fileUtils.js';
import { parseZip, collectZipEntry, MAX_ZIP_MEMBER_BYTES } from '../lib/zipStream.js';
import { parseExport, importConversations, assetPointerId } from './chatgptImport.js';
import { ServerError } from '../lib/errorHandler.js';

// Cap an individual member (JSON shard buffered in memory, or `.dat` asset
// streamed to disk). The largest conversation shard in a real export is ~6 MB
// and assets run KB–few MB; 100 MB is a generous per-member backstop against a
// malicious zip claiming one member is enormous. Assets stream straight to disk
// (peak RAM is one chunk), so there is no aggregate in-memory ceiling to keep —
// a legitimately large multi-GB export imports without an arbitrary budget.
const MAX_MEMBER_BYTES = MAX_ZIP_MEMBER_BYTES;

// Leading bytes captured from each streamed asset to sniff its magic-byte type
// (the widest sniff — WAV/WebP — reads bytes 8–11). Everything past this streams
// straight to the temp file without being held.
const SNIFF_BYTES = 12;

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

// Stream a `.dat` entry straight to `filePath`, holding only the leading
// `SNIFF_BYTES` so the asset's real extension can be sniffed without buffering
// the whole file (peak RAM is one chunk). Enforces the per-member size cap.
// Resolves with the sniffed extension (or null when the magic bytes aren't
// recognized — the caller then falls back to the friendly name / `.bin`).
const streamAssetToFile = (entry, filePath, max) => new Promise((resolve, reject) => {
  const out = createWriteStream(filePath);
  const head = [];
  let headLen = 0;
  let size = 0;
  let done = false;
  const fail = (err) => { if (done) return; done = true; out.destroy(); reject(err); };
  out.on('error', fail);
  const sink = new Writable({
    write(chunk, _enc, cb) {
      size += chunk.length;
      if (size > max) { cb(new Error(`ZIP member exceeds ${max} byte limit`)); return; }
      if (headLen < SNIFF_BYTES) {
        // Keep only the bytes still needed to reach SNIFF_BYTES, so `head` holds
        // at most SNIFF_BYTES regardless of how the producer chunks the asset.
        const slice = chunk.subarray(0, SNIFF_BYTES - headLen);
        head.push(slice);
        headLen += slice.length;
      }
      if (out.write(chunk)) cb();
      else out.once('drain', cb);
    },
    final(cb) { out.end(cb); },
  });
  sink.on('error', fail);
  out.on('finish', () => { if (done) return; done = true; resolve(sniffExtension(Buffer.concat(head))); });
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
  await ensureDir(assetDir);

  const convoBuffers = [];          // { path, buffer }
  let assetNameMap = {};
  // assetId -> { datPath, tempPath, sniffedExt } recorded as each `.dat` streams
  // to a temp file; we rename to the final `<assetId><ext>` name after the
  // stream closes, because the name map may arrive after the .dat members
  // (member order in the ZIP isn't guaranteed). `tempPaths` tracks every temp
  // file written so a mid-stream failure can clean partial writes off disk.
  const pendingAssets = new Map();
  const tempPaths = new Set();
  // Every per-member task (asset writes, JSON collects). Hoisted out of the
  // Promise executor so the rejection handler below can wait for in-flight asset
  // writes to fully settle (their write streams close) before unlinking temp
  // files — otherwise a write that finishes AFTER the unlink re-creates the
  // `.part` file and orphans it (a filesystem-timing race under heavy I/O).
  const inFlight = [];

  await new Promise((resolve, reject) => {
    let settled = false;
    const src = createReadStream(zipPath);
    const parser = parseZip();
    // On any error/settle, tear down both streams. Rejecting the Promise alone
    // doesn't stop ingestion — the read stream keeps flowing into the parser and
    // entries keep streaming to disk, so a per-member overflow would otherwise
    // keep writing *after* the failure already fired. Temp files left behind are
    // cleaned by `tempPaths` below.
    const settle = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      if (fn === reject) { src.destroy(); parser.destroy?.(); }
      fn(arg);
    };
    const onErr = settle(reject);

    src
      .on('error', onErr)
      .pipe(parser)
      .on('entry', (entry) => {
        const { path } = entry;
        if (IS_ASSET_NAME_MAP(path)) {
          inFlight.push(collectZipEntry(entry, MAX_MEMBER_BYTES)
            .then((buf) => { assetNameMap = JSON.parse(buf.toString('utf8')); })
            .catch(onErr));
        } else if (IS_CONVO_JSON(path)) {
          inFlight.push(collectZipEntry(entry, MAX_MEMBER_BYTES)
            .then((buf) => { convoBuffers.push({ path, buffer: buf }); })
            .catch(onErr));
        } else if (IS_DAT(path)) {
          // Stream the asset straight to a temp file, holding only its leading
          // bytes to sniff the extension. Peak RAM is one chunk regardless of
          // asset size, so there is no aggregate ceiling and a multi-GB export
          // imports without OOM risk. Renamed to its final served name below.
          const assetId = datAssetId(path);
          const tempPath = `${assetDir}/${assetId}.part`;
          tempPaths.add(tempPath);
          inFlight.push(streamAssetToFile(entry, tempPath, MAX_MEMBER_BYTES)
            .then((sniffedExt) => { pendingAssets.set(assetId, { datPath: path, tempPath, sniffedExt }); })
            .catch(onErr));
        } else {
          // chat.html, export_manifest.json, library_files.json, user.json, etc.
          // — not needed for the transcript+asset import. Drain without buffering.
          entry.autodrain();
        }
      })
      .on('close', () => { Promise.all(inFlight).then(settle(resolve), onErr); })
      .on('error', onErr);
  }).catch(async (err) => {
    // Streaming failed (size cap, parser error, …) — assets already streamed to
    // temp files would otherwise be orphaned on disk. Remove them before
    // re-throwing so a bad upload can't accumulate `.part` files.
    //
    // Wait for every in-flight member task to settle FIRST. `settle(reject)`
    // rejects this Promise immediately and destroys the source/parser, but a
    // `streamAssetToFile` whose write stream hasn't finished is still mid-flight:
    // `createWriteStream` opens its `.part` file asynchronously, so unlinking now
    // can race the open — the unlink no-ops (file not created yet), then the open
    // lands and orphans the `.part` (the intermittent full-suite failure). The
    // parser's teardown ends the in-flight entry stream (see zipStream.js
    // `destroy`), so each task settles deterministically — once `allSettled`
    // resolves, every write handle is closed and the file's on-disk existence is
    // settled, making the unlink below final rather than racing a pending open.
    await Promise.allSettled(inFlight);
    await cleanupTempFiles(tempPaths);
    throw err;
  });

  // Rename each streamed temp file to its final served name, resolving the
  // extension from the sniffed magic bytes, then the friendly-name fallback,
  // then `.bin`. On any failure, clean up both the renamed assets and any
  // still-unfinalized temp files so nothing is orphaned.
  const assets = new Map();
  try {
    for (const [assetId, { datPath, tempPath, sniffedExt }] of pendingAssets) {
      const friendlyName = assetNameMap[`${assetId}.dat`] || assetNameMap[datPath] || null;
      const ext = sniffedExt || extFromName(friendlyName) || '.bin';
      const fileName = `${assetId}${ext}`;
      const filePath = `${assetDir}/${fileName}`;
      // eslint-disable-next-line no-await-in-loop -- sequential rename keeps peak
      // disk/IO bounded; an export has a few hundred assets, not millions.
      await rename(tempPath, filePath);
      assets.set(assetId, {
        url: `/data/brain-imports/${fileName}`,
        name: friendlyName || fileName,
        mime: getMimeType(ext),
        file: fileName,
      });
    }
  } catch (err) {
    await cleanupExtractedAssets(assets, assetDir);
    await cleanupTempFiles(tempPaths);
    throw err;
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

// Remove the `.part` temp files written while streaming assets to disk. Called
// when extraction fails before (or during) the rename-to-final step so a
// partial/aborted import doesn't leave orphaned temp files behind. Already-
// renamed temps no longer exist — the unlink simply no-ops on them.
async function cleanupTempFiles(tempPaths) {
  await Promise.all([...tempPaths].map((p) => unlink(p).catch(() => {})));
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

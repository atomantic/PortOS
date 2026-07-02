/**
 * ChatGPT Import Service
 *
 * Parses ChatGPT data exports and imports them as Brain Memory entries. Full
 * conversation transcripts are also archived to
 * `data/brain/imports/chatgpt/<conversation-id>.json` so the original structure
 * (mapping tree, model, citations) and a rich markdown transcript are preserved
 * for the in-app conversation viewer.
 *
 * Two upload shapes are supported:
 *   - The legacy single `conversations.json` (parsed in the browser, POSTed as
 *     JSON). No assets — image/audio parts render as `[image]` / `[audio]`.
 *   - The modern multi-file ZIP export (streamed up whole, extracted server-
 *     side by `chatgptZipImport.js`). That path passes an `assetResolver` so
 *     image/audio/file parts render as inline markdown (`![name](url)`,
 *     `[🔊 audio](url)`, `[📎 file](url)`) pointing at the extracted assets.
 *
 * `parseExport` / `summarizeConversation` / `extractMessages` all accept an
 * optional `{ assetResolver }`; when omitted they behave exactly as before.
 */

import { join } from 'path';
import { unlink } from 'fs/promises';
import { atomicWrite, ensureDir, PATHS, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { createMemoryEntry } from './brainStorage.js';

const MAX_MEMORY_CONTENT = 9800;
const MAX_TITLE_LEN = 200;
const MAX_TAG_LEN = 50;
const ROLE_LABEL = { user: 'You', assistant: 'ChatGPT', system: 'System', tool: 'Tool' };
// Resolve lazily — computing it at module load reads PATHS.brain, which is
// undefined in suites that mock fileUtils with a partial PATHS (e.g.
// brain.test.js) and would crash the import. Each call is a cheap path join.
const importRoot = () => join(PATHS.brain, 'imports', 'chatgpt');

const sanitizeTag = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9-_]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, MAX_TAG_LEN);

const cleanTitle = (s, fallback = 'Untitled conversation') => {
  const trimmed = String(s || '').trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_TITLE_LEN ? `${trimmed.slice(0, MAX_TITLE_LEN - 1)}…` : trimmed;
};

/**
 * Normalize a ChatGPT asset pointer to its bare file id. Pointers appear as
 * `file-service://file-XXX`, `sediment://file_HASH`, or (in `attachments`) a
 * bare `file-XXX` id. The matching on-disk asset is `<id>.dat`.
 */
export const assetPointerId = (pointer) => String(pointer || '')
  .replace(/^file-service:\/\//, '')
  .replace(/^sediment:\/\//, '')
  .trim();

const escapeMd = (s) => String(s || '').replace(/([\\`*_[\]()])/g, '\\$1');

/**
 * Render one message part to markdown text. `assetResolver(pointer)` returns
 * `{ url, name, mime } | null` for an extracted asset (ZIP path), or is null
 * (legacy JSON path) — in which case asset parts degrade to `[image]` etc.
 * `renderedIds` collects the asset ids we inlined so `extractMessages` can
 * avoid double-listing them in the message's attachment footer.
 */
const partToText = (part, assetResolver, renderedIds) => {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';

  const ct = part.content_type;

  // Spoken-turn transcript text — render the words, not a placeholder.
  if (ct === 'audio_transcription' && typeof part.text === 'string') return part.text;

  if (ct === 'image_asset_pointer') {
    const resolved = assetResolver?.(part.asset_pointer);
    if (resolved?.url) {
      if (renderedIds) renderedIds.add(assetPointerId(part.asset_pointer));
      return `\n\n![${escapeMd(resolved.name || 'image')}](${resolved.url})\n`;
    }
    return '[image]';
  }

  if (ct === 'audio_asset_pointer') {
    const resolved = assetResolver?.(part.asset_pointer);
    if (resolved?.url) {
      if (renderedIds) renderedIds.add(assetPointerId(part.asset_pointer));
      return `[🔊 ${escapeMd(resolved.name || 'audio')}](${resolved.url})`;
    }
    return '[audio]';
  }

  if (ct === 'real_time_user_audio_video_asset_pointer') {
    const resolved = assetResolver?.(part.asset_pointer);
    if (resolved?.url) {
      if (renderedIds) renderedIds.add(assetPointerId(part.asset_pointer));
      return `[🎙️ ${escapeMd(resolved.name || 'voice message')}](${resolved.url})`;
    }
    return '[voice message]';
  }

  if (typeof part.text === 'string') return part.text;
  if (ct) return `[${ct}]`;
  return '';
};

/**
 * Reduce a single message's `content.parts` array into a plain text / markdown
 * string. Returns `{ text, renderedIds }` so the caller can dedupe attachments.
 */
const renderParts = (parts, assetResolver) => {
  const renderedIds = new Set();
  if (!Array.isArray(parts)) return { text: '', renderedIds };
  const text = parts
    .map((part) => partToText(part, assetResolver, renderedIds))
    .filter(Boolean)
    .join('\n');
  return { text, renderedIds };
};

// Kept for back-compat with the existing unit tests (`__test.partsToText`).
const partsToText = (parts) => renderParts(parts, null).text;

/**
 * Render a message's `metadata.attachments` (files the user attached) as a
 * markdown footer of links — skipping any already inlined as image parts.
 * Non-image attachments (PDFs, docs, spreadsheets) only appear here, never as
 * parts, so this is the only place they surface.
 */
const renderAttachments = (msg, assetResolver, renderedIds) => {
  const attachments = msg?.metadata?.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const links = [];
  for (const att of attachments) {
    const id = att?.id;
    if (!id || renderedIds.has(id)) continue;
    const resolved = assetResolver?.(id);
    if (resolved?.url) {
      const icon = (resolved.mime || att.mime_type || '').startsWith('image/') ? '🖼️' : '📎';
      links.push(`[${icon} ${escapeMd(resolved.name || att.name || 'file')}](${resolved.url})`);
    }
  }
  return links.length ? `\n\n${links.join('\n')}` : '';
};

/**
 * Walk the `mapping` tree of a conversation from `current_node` back to the
 * root, then reverse — that path is the visible conversation thread (ChatGPT
 * mappings can include alternate branches from edits/regenerations).
 */
export function extractMessages(conversation, { assetResolver = null } = {}) {
  if (!conversation || typeof conversation !== 'object') return [];
  const mapping = conversation.mapping || {};
  const seen = new Set();
  const path = [];
  let nodeId = conversation.current_node;
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    path.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  path.reverse();

  const messages = [];
  for (const node of path) {
    const msg = node.message;
    if (!msg) continue;
    const role = msg.author?.role;
    if (!role || role === 'system') continue;
    const { text: partsText, renderedIds } = renderParts(msg.content?.parts, assetResolver);
    const attachmentText = renderAttachments(msg, assetResolver, renderedIds);
    const text = `${partsText}${attachmentText}`;
    if (!text.trim()) continue;
    messages.push({
      id: msg.id || node.id,
      role,
      text,
      createTime: typeof msg.create_time === 'number' ? msg.create_time : null
    });
  }
  return messages;
}

/**
 * Render an array of {role,text} messages as a markdown-ish transcript.
 */
export function formatTranscript(messages) {
  return messages
    .map((m) => `**${ROLE_LABEL[m.role] || m.role}**:\n${m.text}`)
    .join('\n\n---\n\n');
}

const epochToISO = (epoch) => {
  if (typeof epoch !== 'number' || !isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
};

/**
 * Build a lightweight summary record for a parsed conversation.
 */
export function summarizeConversation(conversation, { assetResolver = null } = {}) {
  const messages = extractMessages(conversation, { assetResolver });
  const userMessages = messages.filter((m) => m.role === 'user').length;
  const assistantMessages = messages.filter((m) => m.role === 'assistant').length;
  const transcript = formatTranscript(messages);
  // Count inlined assets (markdown image embeds + asset link icons) for the
  // preview/summary so the wizard can report "N conversations, M assets".
  const assetCount = (transcript.match(/!\[[^\]]*\]\([^)]+\)|\[(?:🔊|🎙️|🖼️|📎)[^\]]*\]\([^)]+\)/g) || []).length;
  return {
    id: conversation.id || conversation.conversation_id || null,
    title: cleanTitle(conversation.title),
    createTime: epochToISO(conversation.create_time),
    updateTime: epochToISO(conversation.update_time),
    messageCount: messages.length,
    userMessages,
    assistantMessages,
    charCount: transcript.length,
    assetCount,
    gizmoId: conversation.gizmo_id || null,
    messages,
    transcript
  };
}

/**
 * Parse a raw conversations payload into analysis + per-conversation summaries.
 * Accepts: a top-level array of conversations, an object with a `conversations`
 * array (legacy single-file `conversations.json`), OR an object with a
 * `conversationFiles` array of already-parsed JSON payloads (the multi-file ZIP
 * path, where each `conversations-NNN.json` is its own array/object).
 */
export function parseExport(raw, { assetResolver = null } = {}) {
  let conversations;
  if (Array.isArray(raw)) {
    conversations = raw;
  } else if (raw && Array.isArray(raw.conversations)) {
    conversations = raw.conversations;
  } else if (raw && Array.isArray(raw.conversationFiles)) {
    // Multi-file export: flatten every shard into one conversation list.
    conversations = raw.conversationFiles.flatMap((shard) =>
      Array.isArray(shard) ? shard : (Array.isArray(shard?.conversations) ? shard.conversations : []));
  } else {
    return { ok: false, error: 'Expected an array of conversations or an object with a "conversations" array.' };
  }

  if (conversations.length === 0) {
    return { ok: false, error: 'No conversations found in the upload.' };
  }

  const summaries = [];
  let totalMessages = 0;
  let totalChars = 0;
  let totalAssets = 0;
  let earliest = null;
  let latest = null;
  const gizmos = new Set();

  for (const c of conversations) {
    const s = summarizeConversation(c, { assetResolver });
    summaries.push(s);
    totalMessages += s.messageCount;
    totalChars += s.charCount;
    totalAssets += s.assetCount;
    if (s.gizmoId) gizmos.add(s.gizmoId);
    if (s.createTime && (!earliest || s.createTime < earliest)) earliest = s.createTime;
    if (s.updateTime && (!latest || s.updateTime > latest)) latest = s.updateTime;
  }

  return {
    ok: true,
    summary: {
      totalConversations: summaries.length,
      totalMessages,
      totalChars,
      totalAssets,
      earliest,
      latest,
      gizmoCount: gizmos.size
    },
    conversations: summaries
  };
}

/**
 * Strip the heavy transcript/messages fields so the preview payload sent to
 * the client stays small for large exports.
 */
export function stripPreview(parsed) {
  if (!parsed?.ok) return parsed;
  return {
    ok: true,
    summary: parsed.summary,
    conversations: parsed.conversations.map(({ messages, transcript, ...rest }) => rest)
  };
}

const safeFilename = (s) => String(s || 'conversation')
  .replace(/[^a-zA-Z0-9-_]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'conversation';

/**
 * Read one archived conversation transcript by its archive filename (the
 * `sourceRef` stored on a chatgpt-import Memory entry). Returns null if the
 * name escapes the archive dir or the file is missing — the conversation
 * viewer falls back to the truncated Memory `content` in that case.
 */
export async function readArchivedConversation(archiveName) {
  const name = String(archiveName || '');
  // Reject path traversal — archive names are flat `<safe-id>.json`.
  if (!/^[a-zA-Z0-9-_]+\.json$/.test(name)) return null;
  const raw = await tryReadFile(join(importRoot(), name));
  if (!raw) return null;
  return safeJSONParse(raw, null, { allowArray: false });
}

// Served-asset URL prefix every imported image/audio/file link points at (see
// chatgptZipImport.js — assets land at `/data/brain-imports/<assetId><ext>`).
const ASSET_URL_PREFIX = '/data/brain-imports/';

/**
 * Extract the bare asset filenames an imported memory's markdown `content`
 * references (`/data/brain-imports/<file>`). Returns a Set of filenames (no
 * directory, no query/hash). The leading-bytes restriction in the asset
 * filename charset means a simple bounded match is safe against path traversal —
 * we additionally reject any name that isn't a flat basename below.
 */
export const extractAssetFileNames = (content) => {
  const names = new Set();
  if (typeof content !== 'string') return names;
  // Match the served prefix followed by a flat filename (no slash) up to the
  // markdown link close `)`, whitespace, or end — then strip any trailing
  // punctuation a transcript might place right after the URL.
  const re = new RegExp(`${ASSET_URL_PREFIX.replace(/\//g, '\\/')}([^)\\s]+)`, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].replace(/[).,]+$/, '');
    // Served asset names are `<assetId><ext>` (see chatgptZipImport.js) and are
    // flat in practice. These guards are the actual safety boundary regardless
    // of how the producer names files: the charset anchor rejects `/`, `\`,
    // null bytes, and stray query-string/punctuation tails, and the explicit
    // `..` reject keeps it a strict superset of the prior path-traversal guard
    // (the charset alone would admit a literal `..`, which `join` resolves to
    // the parent dir). Together a crafted link can't produce a name we'd hand
    // to unlink() that escapes — or names — the assets dir.
    if (/^[a-zA-Z0-9._-]+$/.test(name) && !name.includes('..')) {
      names.add(name);
    }
  }
  return names;
};

/**
 * Every asset filename an import memory references — across BOTH its (possibly
 * truncated) `content` AND its full archived transcript. The memory `content`
 * is capped at MAX_MEMORY_CONTENT, so an asset linked only past the truncation
 * point is invisible in `content` but present in the archive; unioning the two
 * catches it. Reads the archive only when the memory carries a `sourceRef`.
 */
const assetNamesForMemory = async (record) => {
  const names = extractAssetFileNames(record?.content);
  if (record?.sourceRef) {
    const archive = await readArchivedConversation(record.sourceRef);
    if (typeof archive?.transcript === 'string') {
      for (const name of extractAssetFileNames(archive.transcript)) names.add(name);
    }
  }
  return names;
};

/**
 * Delete the on-disk assets + archived transcript that belonged to a deleted
 * `chatgpt-import` memory, leaving no orphans under `data/brain/imports/`.
 *
 * `survivors` is every OTHER live import memory. Neither the archive nor an
 * asset is unlinked while a survivor still references it:
 *   - The transcript JSON is keyed on the conversation id (`sourceRef`), so
 *     importing the same export twice yields two memories pointing at ONE
 *     archive — deleting one must not strand the other's "View full
 *     conversation" / re-summarize path. Keep the archive while any survivor
 *     shares its `sourceRef`.
 *   - An asset id can likewise recur across conversations (ChatGPT reuses a
 *     `file-service://` id), so an asset is only unlinked when NO survivor
 *     still references it — compared via the FULL archived transcript, not the
 *     truncated `content`, so an asset linked only in a survivor's truncated
 *     tail isn't wrongly pulled out from under it.
 *
 * Best-effort: a missing file is a no-op (already gone), and any unlink failure
 * is logged but never thrown — cleanup must not turn a successful delete into a
 * request error.
 */
export async function deleteMemoryAssets(record, survivors = []) {
  if (!record || record.source !== 'chatgpt-import') return;

  // Resolve the deleted record's full asset set BEFORE unlinking its transcript
  // below (the transcript is one of the sources we read asset links from).
  const referenced = await assetNamesForMemory(record);

  // 1. Archived transcript — remove only when no surviving import shares it (a
  // re-import of the same conversation reuses the same `<id>.json` archive).
  const ref = String(record.sourceRef || '');
  const refStillUsed = survivors.some((m) => m?.sourceRef === ref);
  if (/^[a-zA-Z0-9-_]+\.json$/.test(ref) && !refStillUsed) {
    await unlink(join(importRoot(), ref)).catch((err) => {
      if (err?.code !== 'ENOENT') console.error(`⚠️ Failed to remove archived transcript ${ref}: ${err.message}`);
    });
  }

  // 2. Served assets — only those no surviving import memory still references
  // (in its content OR its full archive). Short-circuit when this memory had no
  // assets so an asset-free conversation never reads a single survivor archive.
  if (referenced.size === 0) return;
  const stillUsed = new Set();
  for (const m of survivors) {
    for (const name of await assetNamesForMemory(m)) stillUsed.add(name);
  }
  const orphaned = [...referenced].filter((name) => !stillUsed.has(name));
  await Promise.all(orphaned.map((name) =>
    unlink(join(PATHS.brainImportAssets, name)).catch((err) => {
      if (err?.code !== 'ENOENT') console.error(`⚠️ Failed to remove import asset ${name}: ${err.message}`);
    })
  ));
  if (orphaned.length) console.log(`🧠 Removed ${orphaned.length} orphaned import asset(s) for memory ${record.id}`);
}

/**
 * Persist one conversation's full transcript + structured messages to the
 * import archive directory.
 */
async function archiveConversation(summary) {
  await ensureDir(importRoot());
  const id = summary.id || `conv-${Date.now()}`;
  const fname = `${safeFilename(id)}.json`;
  const filePath = join(importRoot(), fname);
  const payload = {
    id,
    title: summary.title,
    createTime: summary.createTime,
    updateTime: summary.updateTime,
    messageCount: summary.messageCount,
    assetCount: summary.assetCount,
    gizmoId: summary.gizmoId,
    messages: summary.messages,
    transcript: summary.transcript,
    importedAt: new Date().toISOString()
  };
  await atomicWrite(filePath, payload);
  return fname;
}

const buildContent = (summary) => {
  const header = [
    `Source: ChatGPT export`,
    summary.createTime ? `Started: ${summary.createTime}` : null,
    summary.updateTime ? `Updated: ${summary.updateTime}` : null,
    `Messages: ${summary.messageCount}`,
    summary.assetCount ? `Assets: ${summary.assetCount}` : null
  ].filter(Boolean).join('\n');
  const body = summary.transcript;
  const combined = `${header}\n\n${body}`;
  if (combined.length <= MAX_MEMORY_CONTENT) return combined;
  const truncated = combined.slice(0, MAX_MEMORY_CONTENT - 80).trimEnd();
  return `${truncated}\n\n…(transcript truncated — open the full conversation to see everything)`;
};

/**
 * Create a Brain Memory entry for each summarised conversation. Conversations
 * with zero messages are skipped (they appear in ChatGPT exports as empty
 * shells when the user starts a chat but never sends a message).
 *
 * Returns counts and per-conversation result records so the wizard can show
 * which entries were skipped/imported.
 */
export async function importConversations(parsed, options = {}) {
  if (!parsed?.ok) return { ok: false, error: parsed?.error || 'Invalid parsed payload' };

  const baseTags = (options.tags || ['chatgpt-import'])
    .map(sanitizeTag)
    .filter(Boolean);
  const skipEmpty = options.skipEmpty !== false;

  await ensureDir(importRoot());

  const results = [];
  let imported = 0;
  let skipped = 0;
  let archived = 0;

  for (const summary of parsed.conversations) {
    if (skipEmpty && summary.messageCount === 0) {
      results.push({ id: summary.id, title: summary.title, status: 'skipped', reason: 'empty' });
      skipped += 1;
      continue;
    }

    const archiveName = await archiveConversation(summary);
    archived += 1;

    const tags = [
      ...baseTags,
      summary.gizmoId ? sanitizeTag(`gizmo-${summary.gizmoId}`) : null
    ].filter(Boolean);

    const entry = await createMemoryEntry({
      title: summary.title,
      content: buildContent(summary),
      tags,
      source: 'chatgpt-import',
      sourceRef: archiveName,
      // Both source clocks are persisted so the memory list can order imports by
      // the original conversation recency (updateTime preferred) rather than the
      // shared bulk-import timestamp. See `memoryRecencyMs` in brainStorage.js.
      sourceCreatedAt: summary.createTime || null,
      sourceUpdatedAt: summary.updateTime || null
    });

    results.push({
      id: summary.id,
      memoryId: entry.id,
      title: summary.title,
      messageCount: summary.messageCount,
      assetCount: summary.assetCount,
      archiveName,
      status: 'imported'
    });
    imported += 1;
  }

  return {
    ok: true,
    imported,
    skipped,
    archived,
    archiveDir: importRoot(),
    results
  };
}

export const __test = { sanitizeTag, cleanTitle, partsToText, buildContent, assetPointerId, extractAssetFileNames };

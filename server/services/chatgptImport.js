/**
 * ChatGPT Import Service
 *
 * Parses ChatGPT data exports (`conversations.json`) and imports them as
 * Brain Memory entries. Full conversation transcripts are also archived to
 * `data/brain/imports/chatgpt/<conversation-id>.json` so that the original
 * structure (mapping tree, model, citations) is preserved if a richer viewer
 * is added later.
 */

import { join } from 'path';
import { writeFile } from 'fs/promises';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { createMemoryEntry } from './brainStorage.js';

const MAX_MEMORY_CONTENT = 9800;
const MAX_TITLE_LEN = 200;
const MAX_TAG_LEN = 50;
const ROLE_LABEL = { user: 'You', assistant: 'ChatGPT', system: 'System', tool: 'Tool' };
const IMPORT_ROOT = join(PATHS.brain, 'imports', 'chatgpt');

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
 * Reduce a single message's `content.parts` array into a plain text string.
 * ChatGPT parts can be strings, or objects (image_asset_pointer, code, etc.).
 */
const partsToText = (parts) => {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        if (typeof part.text === 'string') return part.text;
        if (part.content_type === 'image_asset_pointer') return '[image]';
        if (part.content_type === 'audio_transcription' && typeof part.text === 'string') return part.text;
        if (part.content_type) return `[${part.content_type}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

/**
 * Walk the `mapping` tree of a conversation from `current_node` back to the
 * root, then reverse — that path is the visible conversation thread (ChatGPT
 * mappings can include alternate branches from edits/regenerations).
 */
export function extractMessages(conversation) {
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
    const text = partsToText(msg.content?.parts);
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
export function summarizeConversation(conversation) {
  const messages = extractMessages(conversation);
  const userMessages = messages.filter((m) => m.role === 'user').length;
  const assistantMessages = messages.filter((m) => m.role === 'assistant').length;
  const transcript = formatTranscript(messages);
  return {
    id: conversation.id || conversation.conversation_id || null,
    title: cleanTitle(conversation.title),
    createTime: epochToISO(conversation.create_time),
    updateTime: epochToISO(conversation.update_time),
    messageCount: messages.length,
    userMessages,
    assistantMessages,
    charCount: transcript.length,
    gizmoId: conversation.gizmo_id || null,
    messages,
    transcript
  };
}

/**
 * Parse a raw `conversations.json` payload (array OR object with `conversations`).
 * Returns analysis + per-conversation summaries (without full transcripts) so
 * the client can render a preview without round-tripping huge payloads.
 */
export function parseExport(raw) {
  let conversations;
  if (Array.isArray(raw)) {
    conversations = raw;
  } else if (raw && Array.isArray(raw.conversations)) {
    conversations = raw.conversations;
  } else {
    return { ok: false, error: 'Expected an array of conversations or an object with a "conversations" array.' };
  }

  if (conversations.length === 0) {
    return { ok: false, error: 'No conversations found in the upload.' };
  }

  const summaries = [];
  let totalMessages = 0;
  let totalChars = 0;
  let earliest = null;
  let latest = null;
  const gizmos = new Set();

  for (const c of conversations) {
    const s = summarizeConversation(c);
    summaries.push(s);
    totalMessages += s.messageCount;
    totalChars += s.charCount;
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
 * Persist one conversation's full transcript + structured messages to the
 * import archive directory.
 */
async function archiveConversation(summary) {
  await ensureDir(IMPORT_ROOT);
  const id = summary.id || `conv-${Date.now()}`;
  const fname = `${safeFilename(id)}.json`;
  const filePath = join(IMPORT_ROOT, fname);
  const payload = {
    id,
    title: summary.title,
    createTime: summary.createTime,
    updateTime: summary.updateTime,
    messageCount: summary.messageCount,
    gizmoId: summary.gizmoId,
    messages: summary.messages,
    transcript: summary.transcript,
    importedAt: new Date().toISOString()
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return fname;
}

const buildContent = (summary) => {
  const header = [
    `Source: ChatGPT export`,
    summary.createTime ? `Started: ${summary.createTime}` : null,
    summary.updateTime ? `Updated: ${summary.updateTime}` : null,
    `Messages: ${summary.messageCount}`
  ].filter(Boolean).join('\n');
  const body = summary.transcript;
  const combined = `${header}\n\n${body}`;
  if (combined.length <= MAX_MEMORY_CONTENT) return combined;
  const truncated = combined.slice(0, MAX_MEMORY_CONTENT - 80).trimEnd();
  return `${truncated}\n\n…(transcript truncated — full content archived in data/brain/imports/chatgpt)`;
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

  await ensureDir(IMPORT_ROOT);

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
      sourceCreatedAt: summary.createTime || null
    });

    results.push({
      id: summary.id,
      memoryId: entry.id,
      title: summary.title,
      messageCount: summary.messageCount,
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
    archiveDir: IMPORT_ROOT,
    results
  };
}

export const __test = { sanitizeTag, cleanTitle, partsToText, buildContent };

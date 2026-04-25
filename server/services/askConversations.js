/**
 * Ask Conversations
 *
 * Persistent storage for "Ask Yourself" conversations — the chat transcript
 * the user has with their digital twin, with sources cited per turn.
 *
 * Each conversation is one JSON file under data/ask-conversations/<id>.json.
 * Files older than 30 days are auto-pruned on list, unless the user has
 * pinned them via setPromoted().
 *
 * Conversation shape:
 *   { id, title, mode, createdAt, updatedAt, promoted, turns[] }
 * Turn shape:
 *   { id, role: 'user'|'assistant', content, sources?, mode?, providerId?, model?, createdAt }
 *
 * Conversation ids are sortable: `ask_<base36-ms-padded>_<hex>`. Lexically
 * sorting filenames descending returns newest-first without reading any
 * file, which lets `listConversations` JSON-parse only the head of the
 * list to fill summaries. Beyond the page cutoff we `stat()` each file
 * (mtime fast path) and only open the JSON for files whose mtime is older
 * than the 30-day expiry — those need a JSON read to honour the `promoted`
 * flag. Net cost: O(limit) JSON reads + O(N) stats for fresh tails, plus
 * O(stale-files) JSON reads for the prune sweep.
 */

import { join } from 'path';
import { readdir, stat, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, readJSONFile, safeDate } from '../lib/fileUtils.js';
import { VALID_MODES as VALID_MODES_SET } from './askService.js';

export const ASK_DIR = join(PATHS.data, 'ask-conversations');
export const EXPIRY_DAYS = 30;
export const TITLE_MAX_LENGTH = 120;
export { VALID_MODES_SET as VALID_MODES };

const ID_RE = /^ask_[a-z0-9]+_[a-f0-9]+$/;

// Pad base36-ms to 9 chars (35^9 > 5e13, valid until year ~3700) so
// filename lexical order always matches chronological order — without
// padding, a digit rollover would make a newer id sort *before* an older
// one and the newest-first listing would silently flip.
const BASE36_TS_WIDTH = 9;

function generateId() {
  const ts = Date.now().toString(36).padStart(BASE36_TS_WIDTH, '0');
  return `ask_${ts}_${randomUUID().split('-')[0]}`;
}

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function pathFor(id) {
  if (!isValidId(id)) throw new Error(`Invalid conversation id: ${id}`);
  return join(ASK_DIR, `${id}.json`);
}

function truncateTitle(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, TITLE_MAX_LENGTH - 1) + '…';
}

async function readConversation(id) {
  const data = await readJSONFile(pathFor(id), null, { logError: false });
  if (!data || typeof data !== 'object' || data.id !== id) return null;
  return data;
}

export async function getConversation(id) {
  if (!isValidId(id)) return null;
  return readConversation(id);
}

export async function listConversations({ limit = 50 } = {}) {
  await ensureDir(ASK_DIR);
  const entries = await readdir(ASK_DIR).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });

  // Filenames carry a sortable timestamp prefix (`ask_<base36-ms-padded>_…`)
  // so a descending lexical sort gives newest-first ordering without
  // reading any file. The two-tier sweep below uses this: JSON-read the
  // head page for summaries, `stat()` everything else and only JSON-read
  // tail files whose mtime puts them past the expiry window (those are
  // pruning candidates and we still need the JSON to honour `promoted`).
  const ids = entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter(isValidId)
    .sort((a, b) => b.localeCompare(a));

  const summaries = [];
  const now = Date.now();
  const expiryMs = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  // Two-tier sweep: filenames are newest-first, so we only read JSON for
  // (a) the head of the list to fill `summaries`, and (b) anything whose
  // mtime is older than the expiry window — those are pruning candidates
  // and we still have to open them to honour the `promoted` flag. Fresh
  // files past the `limit` cutoff are skipped entirely.
  for (const id of ids) {
    const headSlot = summaries.length < limit;
    let conv = null;
    let mtime = null;
    if (headSlot) {
      conv = await readConversation(id);
      if (!conv) continue;
    } else {
      // Cheap check first — only open the JSON if mtime indicates the file
      // could be expired. atomicWrite touches mtime on every update.
      mtime = await stat(pathFor(id)).then((s) => s.mtimeMs, () => null);
      if (mtime === null) continue;
      if ((now - mtime) <= expiryMs) continue;
      conv = await readConversation(id);
      if (!conv) continue;
    }

    // Fall back to file mtime when the JSON's own timestamps are missing or
    // unparseable — a corrupted record with no usable updatedAt would
    // otherwise live forever because `safeDate(undefined) === 0` made the
    // expiry comparison vacuously false.
    let effectiveTs = safeDate(conv.updatedAt) || safeDate(conv.createdAt);
    if (!effectiveTs) {
      if (mtime === null) {
        mtime = await stat(pathFor(id)).then((s) => s.mtimeMs, () => null);
      }
      if (mtime !== null) effectiveTs = mtime;
    }
    if (!conv.promoted && effectiveTs && (now - effectiveTs) > expiryMs) {
      // Single-user app — no concurrency races to worry about pruning here.
      await unlink(pathFor(id)).catch(() => {});
      continue;
    }

    if (headSlot) {
      summaries.push({
        id: conv.id,
        title: conv.title || '(untitled)',
        mode: conv.mode,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        turnCount: Array.isArray(conv.turns) ? conv.turns.length : 0,
        promoted: !!conv.promoted,
      });
    }
  }

  return summaries;
}

export async function createConversation({ mode = 'ask', title = '' } = {}) {
  if (!VALID_MODES_SET.has(mode)) throw new Error(`Invalid mode: ${mode}`);
  await ensureDir(ASK_DIR);
  const now = new Date().toISOString();
  const conv = {
    id: generateId(),
    title: truncateTitle(title) || '(new conversation)',
    mode,
    createdAt: now,
    updatedAt: now,
    promoted: false,
    turns: [],
  };
  await atomicWrite(pathFor(conv.id), conv);
  return conv;
}

export async function appendTurn(conversationId, turn) {
  const conv = await readConversation(conversationId);
  if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
  if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) {
    throw new Error('Turn must include role of "user" or "assistant"');
  }
  const stamped = {
    id: turn.id || randomUUID(),
    role: turn.role,
    content: typeof turn.content === 'string' ? turn.content : '',
    createdAt: turn.createdAt || new Date().toISOString(),
    ...(turn.sources ? { sources: turn.sources } : {}),
    ...(turn.mode ? { mode: turn.mode } : {}),
    ...(turn.providerId ? { providerId: turn.providerId } : {}),
    ...(turn.model ? { model: turn.model } : {}),
  };
  conv.turns = [...(conv.turns || []), stamped];
  // First user turn becomes the conversation title — give the listing a
  // useful label without a separate naming step.
  if (turn.role === 'user' && (!conv.title || conv.title === '(new conversation)')) {
    conv.title = truncateTitle(turn.content);
  }
  conv.updatedAt = stamped.createdAt;
  await atomicWrite(pathFor(conversationId), conv);
  return { conversation: conv, turn: stamped };
}

export async function deleteConversation(id) {
  if (!isValidId(id)) return false;
  const removed = await unlink(pathFor(id)).then(() => true, (err) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
  return removed;
}

export async function setPromoted(id, promoted) {
  if (!isValidId(id)) return null;
  const conv = await readConversation(id);
  if (!conv) return null;
  conv.promoted = !!promoted;
  conv.updatedAt = new Date().toISOString();
  await atomicWrite(pathFor(id), conv);
  return conv;
}

// Test helper — exposed so tests can introspect/clean state without
// duplicating path math. Not part of the public API.
export const __test = { pathFor, generateId, ASK_DIR };

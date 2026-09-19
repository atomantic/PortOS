/**
 * Persistent Mind bundle export — seal the Mind's *meaning* into one
 * passphrase-encrypted file the user can carry to another install (#7621,
 * epic #7620). Machine-local and user-initiated end to end: nothing here runs
 * on a schedule, calls a provider, or crosses the federation layer.
 *
 * What goes in is decided by scope, and every scope is deliberately narrow.
 * The bundle carries no database ids, no `sourceTaskId`/`sourceAgentId`, no
 * embeddings, no filesystem paths, no hostnames, no peer records, no
 * credentials, and no raw conversation history or rollup text — those are
 * either the `AGENTS.md` Sensitive Data & Privacy categories or install-bound
 * values that would make the bundle un-openable somewhere else.
 *
 * Two exclusions are judgement calls worth naming:
 *
 * - **Capability grants** (`persistentMindCapabilities`) stay home. They are
 *   authority — "may file issues", "may create tasks" — not preference. A
 *   bundle that carried them would let an import quietly widen what a Mind may
 *   do on the destination install.
 * - **`profile.enabled` stays home.** Importing a Mind must never be the thing
 *   that starts one. The destination user starts it themselves.
 * - **Thinking presets stay home.** They bookmark provider/model routes that
 *   exist on THIS machine's registry; the model policy the epic asks for is the
 *   home profile, which travels.
 *
 * Refusal, not partial export: if a selected scope cannot be read, the whole
 * export fails with a named reason. A bundle must never silently omit a scope
 * the user asked for — the user would find out on the destination install,
 * after the source install is gone.
 */

import { ServerError } from '../lib/errorHandler.js';
import { AVATAR_STYLE_IDS } from '../lib/avatarStyles.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { normalizePersistentMindPlaybook } from '../lib/persistentMindPlaybook.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';
import {
  DEFAULT_PERSISTENT_MIND_BUNDLE_SCOPES,
  MIND_BUNDLE_FILE_EXTENSION,
  PERSISTENT_MIND_BUNDLE_SCOPES,
  sealMindBundle,
} from '../lib/mindBundleCrypto.js';
import { loadState } from './cosState.js';
import { readPersistentMindMemories, readPersistentMindName } from './persistentMindContext.js';

export const MIND_BUNDLE_ENTRY_NAMES = Object.freeze({
  profile: 'profile.json',
  avatar: 'avatar.json',
  memories: 'memories.json',
});

/**
 * `readPersistentMindMemories` returns at most this many records. Protected
 * memories sort ahead of ordinary ones, so the protected set is complete unless
 * it fills the page — at which point the export refuses rather than shipping a
 * truncated identity (see `collectMemories`).
 */
const MIND_MEMORY_PAGE_LIMIT = 100;

/** Protected tiers only. `standard` memories are bulk-cleanable noise and stay home. */
const EXPORTABLE_PROTECTIONS = new Set(['core-identity', 'important']);

async function collectProfile() {
  const root = await loadState();
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
  const playbook = normalizePersistentMindPlaybook(root.config?.persistentMindPlaybook);
  const chosenName = await readPersistentMindName(PERSISTENT_MIND_ID);
  return {
    // The Mind's own name, not the machine's and not the user's.
    chosenName: chosenName || null,
    soul: { identity: prompt.identity, instructions: prompt.instructions },
    playbook: { mode: playbook.mode, customInstructions: playbook.customInstructions },
    // Model policy travels; whether it resolves is the destination's problem to
    // surface, not this install's to pre-decide.
    modelPolicy: {
      providerId: profile.providerId || null,
      model: profile.model || null,
      effort: profile.effort || null,
      thinkingInterface: profile.thinkingInterface,
      wakeIntervalMinutes: profile.wakeIntervalMinutes,
    },
  };
}

/**
 * The Mind's presentation. PortOS has no per-Mind avatar image today — the
 * Mind's face is the CoS avatar STYLE, a bundled-vocabulary id. The container
 * is byte-oriented, so the day image bytes exist they become a second entry
 * under this same scope without a new code path.
 */
async function collectAvatar() {
  const root = await loadState();
  const style = root.config?.avatarStyle;
  return { style: AVATAR_STYLE_IDS.includes(style) ? style : null };
}

async function collectMemories() {
  const memories = await readPersistentMindMemories(PERSISTENT_MIND_ID);
  const protectedMemories = memories.filter((memory) => EXPORTABLE_PROTECTIONS.has(memory.protection));
  if (protectedMemories.length >= MIND_MEMORY_PAGE_LIMIT) {
    // The reader is paged; a full page of protected records means there may be
    // more behind it, and a silently short memories scope is exactly the
    // failure this export refuses to produce.
    throw new Error(`this Mind has at least ${MIND_MEMORY_PAGE_LIMIT} protected memories, more than one bundle page can carry without dropping some`);
  }
  return {
    // Meaning only: no ids, no source agent/task, no embeddings, no importance
    // ranking computed against this install's other records.
    memories: protectedMemories.map((memory) => ({
      type: memory.type,
      content: memory.content,
      createdAt: memory.createdAt ? new Date(memory.createdAt).toISOString() : null,
      protection: memory.protection,
    })),
  };
}

const COLLECTORS = Object.freeze({
  profile: collectProfile,
  avatar: collectAvatar,
  memories: collectMemories,
});

/** Stable, de-duplicated scope order so two exports of the same selection match. */
export function normalizeMindBundleScopes(scopes) {
  const requested = new Set(Array.isArray(scopes) && scopes.length > 0 ? scopes : DEFAULT_PERSISTENT_MIND_BUNDLE_SCOPES);
  return PERSISTENT_MIND_BUNDLE_SCOPES.filter((scope) => requested.has(scope));
}

/**
 * Read every selected scope, refusing the whole export if any one of them
 * fails. `allSettled` rather than a bail-on-first-rejection race so the refusal
 * names every scope that could not be read, not just the fastest to fail.
 */
export async function collectPersistentMindBundleEntries(scopes) {
  const selected = normalizeMindBundleScopes(scopes);
  if (selected.length === 0) throw new ServerError('Select at least one scope to export', { status: 400, code: 'MIND_BUNDLE_NO_SCOPES' });

  const results = await Promise.allSettled(selected.map((scope) => COLLECTORS[scope]()));
  const failures = results
    .map((result, index) => (result.status === 'rejected' ? `${selected[index]} (${result.reason?.message || 'unknown error'})` : null))
    .filter(Boolean);
  if (failures.length > 0) {
    throw new ServerError(`Mind bundle export refused: could not read ${failures.join(', ')}. Nothing was exported — a bundle never silently omits a scope you selected.`, {
      status: 409,
      code: 'MIND_BUNDLE_SCOPE_UNREADABLE',
    });
  }

  return {
    scopes: selected,
    entries: selected.map((scope, index) => ({
      name: MIND_BUNDLE_ENTRY_NAMES[scope],
      data: JSON.stringify(results[index].value, null, 2),
    })),
  };
}

/**
 * A generic, install-agnostic filename: no hostname, no user, and not the
 * Mind's chosen name — the file lands in a downloads folder that other people
 * and other tools can see.
 */
export function mindBundleFilename(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  return `portos-mind-${stamp}${MIND_BUNDLE_FILE_EXTENSION}`;
}

/** Seal the selected scopes into one downloadable bundle. Never logs a passphrase or any content. */
export async function exportPersistentMindBundle({ scopes, passphrase }) {
  const { entries, scopes: selected } = await collectPersistentMindBundleEntries(scopes);
  const bundle = await sealMindBundle({ entries, scopes: selected, passphrase });
  console.log(`🔐 Sealed Persistent Mind bundle (scopes: ${selected.join(', ')}; entries: ${entries.length}; bytes: ${bundle.length})`);
  return { bundle, scopes: selected, filename: mindBundleFilename() };
}

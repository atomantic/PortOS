/**
 * Persistent Mind bundle export and import — seal the Mind's *meaning* into
 * one passphrase-encrypted file the user can carry to another install (#7621),
 * and open one here under per-group choices (#7622); epic #7620. Machine-local
 * and user-initiated end to end: nothing here runs on a schedule, calls a
 * provider, or crosses the federation layer.
 *
 * The import half is deliberately two calls, not one. `previewPersistentMindBundle`
 * decrypts and reports; it writes NOTHING, so a user can look inside a bundle
 * (including one that turns out to be the wrong file) without consequence.
 * `applyPersistentMindBundle` is the only write path, and it runs once, after
 * the user has chosen per group.
 *
 * **Whole-group, never a merge.** Each group is taken from the bundle or kept
 * from this install, entire. There is no field-level merge and no three-way
 * text merge, because half of one personality and half of another is not a
 * personality — it is a third one nobody authored. `memories` is the one
 * additive group: it appends and never deletes or rewrites, so its choice
 * reads "import them" / "skip them".
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
import { openMindBundle, sealMindBundle } from '../lib/mindBundleCrypto.js';
import {
  DEFAULT_PERSISTENT_MIND_BUNDLE_SCOPES,
  MIND_BUNDLE_FILE_EXTENSION,
  MIND_BUNDLE_GROUP_SCOPES,
  MIND_BUNDLE_REFUSALS,
  PERSISTENT_MIND_BUNDLE_GROUPS,
  PERSISTENT_MIND_BUNDLE_SCOPES,
  mindBundleRefusal,
} from '../lib/mindBundleFormat.js';
import { loadState } from './cosState.js';
import {
  choosePersistentMindName,
  createPersistentMindMemory,
  readPersistentMindMemories,
  readPersistentMindName,
} from './persistentMindContext.js';

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

/* ------------------------------------------------------------------ import */

/** The scope an entry name belongs to, so an unexpected entry is a refusal. */
const SCOPE_BY_ENTRY_NAME = Object.freeze(Object.fromEntries(
  Object.entries(MIND_BUNDLE_ENTRY_NAMES).map(([scope, name]) => [name, scope]),
));

// Same ceiling the memory reader pages at, and the same content bound a
// mind-authored memory gets (`performAutomaticMemoryCreation`): an imported
// record is held to what a local one would be.
const IMPORTED_MEMORY_CONTENT_MAX = 10_240;
const IMPORTED_MEMORY_TYPE_MAX = 64;

const isPlainRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Normalize one imported memory through the same bounds a locally-created one
 * gets. A bundle is a file from another machine, so its records are foreign
 * input — but an unusable one REFUSES the bundle rather than vanishing from
 * the set. Silently importing 9 of 10 memories is the same failure the export
 * refuses to produce: the user believes they carried everything across, and
 * finds out otherwise only once the source install is gone.
 */
function normalizeImportedMemory(raw, index) {
  if (!isPlainRecord(raw)) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, `Mind bundle memory #${index + 1} is not a record`);
  }
  const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, IMPORTED_MEMORY_CONTENT_MAX) : '';
  if (!content) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, `Mind bundle memory #${index + 1} carries no text`);
  }
  return {
    type: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim().slice(0, IMPORTED_MEMORY_TYPE_MAX) : 'observation',
    content,
    // Protection is preserved, but only within the tiers this export ships.
    // Anything else lands on `important` rather than silently becoming
    // `standard`, which the next bulk cleanup would delete.
    protection: EXPORTABLE_PROTECTIONS.has(raw.protection) ? raw.protection : 'important',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
  };
}

/**
 * Decode and structurally check the entries a bundle carries.
 *
 * Every declared scope must be present and parse; a bundle that declares
 * `memories` and carries no `memories.json` is damaged, not "a bundle with no
 * memories". An entry this build does not recognize is a refusal too — quietly
 * ignoring it is the "apply the parts I happen to understand" behaviour the
 * epic rules out.
 */
function decodeBundleEntries({ header, entries }) {
  const decoded = {};
  for (const entry of entries) {
    const scope = SCOPE_BY_ENTRY_NAME[entry.name];
    if (!scope) {
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.UNKNOWN_SCOPE, `Mind bundle carries an entry this install does not understand ("${entry.name}")`);
    }
    if (!header.scopes.includes(scope)) {
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.UNKNOWN_SCOPE, `Mind bundle carries a "${scope}" entry it never declared`);
    }
    if (decoded[scope]) {
      // The sealer rejects duplicate names, so two entries for one scope means
      // a hand-built file. "Last one wins" would let the winning copy be chosen
      // by parse order rather than by anything the user can see.
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, `Mind bundle carries more than one "${entry.name}"`);
    }
    const parsed = JSON.parse(entry.data.toString('utf8'));
    if (!isPlainRecord(parsed)) {
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, `Mind bundle entry "${entry.name}" is not a record`);
    }
    decoded[scope] = parsed;
  }
  for (const scope of header.scopes) {
    if (!decoded[scope]) {
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, `Mind bundle declares the "${scope}" scope but carries no ${MIND_BUNDLE_ENTRY_NAMES[scope]}`);
    }
  }
  return decoded;
}

/**
 * Translate any open-path failure into a named, user-readable refusal.
 *
 * The reason rides `context`, which is what reaches the client on the standard
 * error envelope — so "refuse by name" survives the trip and the panel can say
 * WHICH refusal it hit rather than "could not open". An untagged throw is a
 * damaged file: every distinguishable failure above already carries its name.
 */
const refuse = (error) => new ServerError(
  error?.message || 'Could not open this Mind bundle',
  {
    status: 400,
    code: 'MIND_BUNDLE_REFUSED',
    context: { reason: error?.mindBundleReason || MIND_BUNDLE_REFUSALS.DAMAGED },
  },
);

/**
 * Decrypt a bundle and decode it. Writes nothing — every caller, preview and
 * apply alike, starts here, so apply never trusts a preview the client could
 * have edited on its way back.
 */
const readBundle = ({ text, passphrase }) => Promise.resolve()
  .then(() => openMindBundle({ text, passphrase }))
  // Group-building runs inside this chain, not after it: it validates the same
  // foreign records, so its refusals need the same named translation.
  .then((result) => ({ header: result.header, groups: incomingGroups(decodeBundleEntries(result)) }))
  .catch((error) => { throw refuse(error); });

/** What this install currently holds, in the same shapes the bundle carries. */
async function readCurrentGroups() {
  const root = await loadState();
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
  const playbook = normalizePersistentMindPlaybook(root.config?.persistentMindPlaybook);
  const style = root.config?.avatarStyle;
  const [chosenName, memories] = await Promise.all([
    readPersistentMindName(PERSISTENT_MIND_ID),
    readPersistentMindMemories(PERSISTENT_MIND_ID),
  ]);
  return {
    identity: { chosenName: chosenName || null },
    personality: { identity: prompt.identity, instructions: prompt.instructions },
    playbook: { mode: playbook.mode, customInstructions: playbook.customInstructions },
    modelPolicy: {
      providerId: profile.providerId || null,
      model: profile.model || null,
      effort: profile.effort || null,
      thinkingInterface: profile.thinkingInterface,
      wakeIntervalMinutes: profile.wakeIntervalMinutes,
    },
    avatar: { style: AVATAR_STYLE_IDS.includes(style) ? style : null },
    memories,
  };
}

/**
 * The incoming value for each group, normalized through the same functions
 * that guard a locally-saved one — so a hand-edited bundle cannot put a shape
 * into config that the UI and the wake loop would then have to survive.
 *
 * A group whose bundle value carries nothing usable is simply absent: offering
 * "use imported" for a name the bundle does not have would let a confirm wipe
 * the destination's own name with nothing.
 */
function incomingGroups(scopeData) {
  const groups = {};
  const profile = scopeData.profile;
  if (profile) {
    const chosenName = typeof profile.chosenName === 'string' ? profile.chosenName.trim() : '';
    if (chosenName) groups.identity = { chosenName };
    // Each of these is offered ONLY when the bundle carries the key. The
    // normalizers turn an absent one into THIS build's shipped defaults, and a
    // group presenting stock text as the other Mind's personality is how a
    // confirm wipes an authored one with something nobody wrote.
    if (isPlainRecord(profile.soul)) {
      const soul = normalizePersistentMindPrompt(profile.soul);
      groups.personality = { identity: soul.identity, instructions: soul.instructions };
    }
    if (isPlainRecord(profile.playbook)) {
      const playbook = normalizePersistentMindPlaybook(profile.playbook);
      groups.playbook = { mode: playbook.mode, customInstructions: playbook.customInstructions };
    }
    if (isPlainRecord(profile.modelPolicy)) {
      // `enabled` is never read off a bundle: importing a Mind must not start one.
      const policy = normalizePersistentMindProfile({ ...profile.modelPolicy, enabled: false });
      groups.modelPolicy = {
        providerId: policy.providerId || null,
        model: policy.model || null,
        effort: policy.effort || null,
        thinkingInterface: policy.thinkingInterface,
        wakeIntervalMinutes: policy.wakeIntervalMinutes,
      };
    }
  }
  if (scopeData.avatar) {
    const style = scopeData.avatar.style;
    if (AVATAR_STYLE_IDS.includes(style)) groups.avatar = { style };
  }
  if (scopeData.memories) {
    const raw = Array.isArray(scopeData.memories.memories) ? scopeData.memories.memories : [];
    if (raw.length > MIND_MEMORY_PAGE_LIMIT) {
      // The exporter refuses rather than truncating, so an over-long set is a
      // hand-built file. Importing its prefix would report a `total` that had
      // already silently dropped the rest.
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, `Mind bundle carries more memories than one bundle can hold (limit ${MIND_MEMORY_PAGE_LIMIT})`);
    }
    groups.memories = raw.map(normalizeImportedMemory);
  }
  return groups;
}

/**
 * The chosen name also travels as a protected memory record (the export ships
 * every protected record, and the name is one). Importing both would plant a
 * second, untagged copy of the name as an ordinary identity memory. The
 * `identity` group owns the name, so the memories group skips it.
 */
const memoryIsTheChosenName = (memory, incomingName) => Boolean(incomingName) && memory.content === incomingName;

function planMemoryImport(incomingMemories, currentMemories, incomingName) {
  const existing = new Set((currentMemories || []).map((memory) => memory.content));
  const seen = new Set();
  const additions = [];
  let duplicates = 0;
  for (const memory of incomingMemories) {
    if (memoryIsTheChosenName(memory, incomingName) || existing.has(memory.content) || seen.has(memory.content)) {
      duplicates += 1;
      continue;
    }
    seen.add(memory.content);
    additions.push(memory);
  }
  return { additions, duplicates };
}

/**
 * Open a bundle and report, group by group, what it carries beside what this
 * install already holds. **Writes nothing.** The preview is what makes the
 * apply step a decision rather than a leap.
 */
export async function previewPersistentMindBundle({ text, passphrase }) {
  const { header, groups: incoming } = await readBundle({ text, passphrase });
  const current = await readCurrentGroups();
  const incomingName = incoming.identity?.chosenName || null;

  const groups = PERSISTENT_MIND_BUNDLE_GROUPS
    .filter((group) => incoming[group] !== undefined)
    .map((group) => {
      if (group === 'memories') {
        const { additions, duplicates } = planMemoryImport(incoming.memories, current.memories, incomingName);
        return {
          group,
          scope: MIND_BUNDLE_GROUP_SCOPES[group],
          additive: true,
          identical: additions.length === 0,
          incoming: { total: incoming.memories.length, importable: additions.length, alreadyHere: duplicates, memories: additions },
          current: { protectedCount: (current.memories || []).filter((memory) => EXPORTABLE_PROTECTIONS.has(memory.protection)).length },
        };
      }
      return {
        group,
        scope: MIND_BUNDLE_GROUP_SCOPES[group],
        additive: false,
        identical: sameValue(incoming[group], current[group]),
        incoming: incoming[group],
        current: current[group],
      };
    });

  console.log(`🔓 Previewed Persistent Mind bundle (scopes: ${header.scopes.join(', ')}; groups: ${groups.length})`);
  return { createdAt: header.createdAt || null, scopes: header.scopes, groups };
}

/**
 * Apply a bundle under the user's per-group choices. The ONLY write path.
 *
 * Everything is validated before the first write: a choice naming a group the
 * bundle does not carry is a refusal, not an ignored key, so a client out of
 * step with this build cannot half-apply. What it cannot promise is atomicity
 * across a config file and Postgres, so the response names exactly which groups
 * landed — a partial failure reports what it did rather than implying nothing
 * happened.
 */
export async function applyPersistentMindBundle({ text, passphrase, choices }) {
  const { groups: incoming } = await readBundle({ text, passphrase });
  const selection = isPlainRecord(choices) ? choices : {};

  const unknown = Object.keys(selection).filter((group) => incoming[group] === undefined);
  if (unknown.length > 0) {
    throw new ServerError(`This bundle does not carry ${unknown.join(', ')}. Nothing was applied — reopen the bundle and choose again.`, {
      status: 409,
      code: 'MIND_BUNDLE_UNKNOWN_GROUP',
    });
  }
  // A group the user did not answer keeps this install's value. Silence is
  // never consent to overwrite a personality.
  const taking = PERSISTENT_MIND_BUNDLE_GROUPS.filter((group) => incoming[group] !== undefined && selection[group] === 'use-imported');
  if (taking.length === 0) {
    return { applied: [], kept: PERSISTENT_MIND_BUNDLE_GROUPS.filter((group) => incoming[group] !== undefined), memories: { imported: 0, skipped: 0 } };
  }

  const configPatch = {};
  if (taking.includes('personality')) configPatch.persistentMindPrompt = incoming.personality;
  if (taking.includes('playbook')) configPatch.persistentMindPlaybook = incoming.playbook;
  if (taking.includes('modelPolicy')) {
    const { providerId, model, effort, thinkingInterface, wakeIntervalMinutes } = incoming.modelPolicy;
    // `enabled` is deliberately absent from the patch so the merge preserves
    // whatever this install already decided about running its Mind.
    configPatch.persistentMindProfile = {
      providerId: providerId || '', model: model || '', effort: effort || '', thinkingInterface, wakeIntervalMinutes,
    };
  }
  if (taking.includes('avatar')) configPatch.avatarStyle = incoming.avatar.style;

  const applied = [];
  if (Object.keys(configPatch).length > 0) {
    // Lazily imported: applying a bundle is a rare, explicitly-clicked path,
    // and `cos.js` is a heavy closure that every suite reaching this module
    // would otherwise pay for (server/AGENTS.md "Import scoping").
    const { updateConfig } = await import('./cos.js');
    await updateConfig(configPatch);
    applied.push(...taking.filter((group) => group !== 'identity' && group !== 'memories'));
  }

  if (taking.includes('identity')) {
    await choosePersistentMindName({ name: incoming.identity.chosenName }, PERSISTENT_MIND_ID);
    applied.push('identity');
  }

  let imported = 0;
  let skipped = 0;
  if (taking.includes('memories')) {
    const current = await readPersistentMindMemories(PERSISTENT_MIND_ID);
    const { additions, duplicates } = planMemoryImport(incoming.memories, current, incoming.identity?.chosenName || null);
    skipped = duplicates;
    for (const memory of additions) {
      // Sequential, not `Promise.all`: these share one write queue, and a
      // partial failure must leave a countable prefix rather than a scramble.
      await createPersistentMindMemory({
        mindId: PERSISTENT_MIND_ID,
        type: memory.type,
        content: memory.content,
        category: 'other',
        protection: memory.protection,
      });
      imported += 1;
    }
    applied.push('memories');
  }
  const memories = { imported, skipped };

  const kept = PERSISTENT_MIND_BUNDLE_GROUPS.filter((group) => incoming[group] !== undefined && !applied.includes(group));
  console.log(`📥 Applied Persistent Mind bundle (used: ${applied.join(', ') || 'none'}; kept: ${kept.join(', ') || 'none'}; memories: +${memories.imported})`);
  return { applied, kept, memories };
}

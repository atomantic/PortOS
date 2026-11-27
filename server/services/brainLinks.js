/** Repository clone lifecycle and link and bucket operations for Brain. */

import * as storage from './brainStorage.js';
import { ensureInstanceId, UNKNOWN_INSTANCE_ID } from './instanceIdentity.js';
import { ServerError } from '../lib/errorHandler.js';
import * as repoCloner from './repoCloner.js';
import { deriveRepoLinkFields } from '../lib/repoLinkFields.js';
import { normalizeRepoIntake } from '../lib/repoIntakeActions.js';
import { v4 as uuidv4 } from '../lib/uuid.js';

// Matches the client's clone stall window (#5442). Past it, a `cloning` record
// this install cannot attribute to itself is treated as orphaned rather than
// left in place — see `shouldRecoverInterruptedClone`.
const CLONE_STALE_MS = 10 * 60 * 1000;

/**
 * Whether THIS install should reset `link` out of `cloning` at boot.
 *
 * Ours, or unattributed (pre-#5463 records carry no `cloneInstanceId`) — always,
 * because no in-process clone survives a restart. A clone another instance owns
 * is left alone while it could still be running, but ages out of that
 * protection: a peer that crashed mid-clone and never comes back must not
 * strand the link at `cloning` forever, which is the whole bug (#5463).
 */
const shouldRecoverInterruptedClone = (link, instanceId) => {
  const owner = link.cloneInstanceId ?? link.originInstanceId ?? null;
  if (!owner || owner === instanceId) return true;
  const updatedAt = Date.parse(link.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= CLONE_STALE_MS;
};

/**
 * Recover repository clones interrupted by a previous server shutdown.
 * Clone work is published only after git exits successfully; an orphaned child
 * can keep writing its private staging directory without racing a retry.
 */
export async function recoverInterruptedRepoClones() {
  // `ensureInstanceId`, not `getInstanceId`: this comparison decides a durable
  // record mutation, and the sentinel would match every other uninitialized
  // install's records while missing our own.
  const instanceId = await ensureInstanceId();
  const links = await storage.getLinks({ cloneStatus: 'cloning' });
  let recovered = 0;
  for (const link of links) {
    // Keep the state guard even though storage applies the filter so a future
    // storage implementation cannot broaden this boot-time mutation by accident.
    if (link.cloneStatus !== 'cloning') continue;
    if (!shouldRecoverInterruptedClone(link, instanceId)) continue;
    const updated = await storage.updateLinkWith(link.id, (fresh) => (
      fresh.cloneStatus === 'cloning' && shouldRecoverInterruptedClone(fresh, instanceId)
        ? {
          cloneStatus: 'failed',
          cloneError: 'Clone interrupted by a server restart. Retry to clone the repository again.',
          cloneInstanceId: null,
          cloneInterrupted: true,
          // A dead attempt must not settle the link if its git child outlived us.
          cloneAttempt: null
        }
        : null
    ));
    if (updated) recovered++;
  }
  if (recovered > 0) {
    console.log(`🧠 Recovered ${recovered} interrupted repository clone(s)`);
  }
  // Detached on purpose: boot AWAITS this function so the first links request
  // can't see an orphaned `cloning` badge, and a recursive scan plus `rm -rf` of
  // abandoned partial checkouts must not sit in front of `startListening()`.
  repoCloner.reapStaleCloneStaging()
    .catch(err => console.error(`❌ Clone staging recovery failed: ${err.message}`));
}

/**
 * Create a bucket appended after all existing ones (next-order logic).
 * Folds the next-order computation into the service so the route stays thin.
 */
export async function createBucketAppended({ name, color, icon }) {
  const existing = await storage.getBuckets();
  const nextOrder = existing.reduce((max, b) => Math.max(max, b.order ?? 0), -1) + 1;
  return storage.createBucket({ name, color: color || 'accent', icon: icon || '', order: nextOrder });
}

/**
 * Delete a bucket and unassign (bucketId → null) all links that belonged to it.
 * Links survive; they fall back to the ungrouped list rather than being orphaned.
 */
export async function deleteBucketAndUnlinkChildren(id) {
  const links = await storage.getLinks();
  let unassigned = 0;
  for (const link of links) {
    if (link.bucketId === id) {
      await storage.updateLink(link.id, { bucketId: null });
      unassigned++;
    }
  }
  await storage.deleteBucket(id);
  return { deleted: true, unassigned };
}

/**
 * Extract a clean hostname from a URL (strip a leading www.), or null if unparseable.
 */
function hostnameFromUrl(url) {
  return URL.parse(url)?.hostname.replace(/^www\./, '') ?? null;
}

/**
 * Clone a repo in the background, tracking progress on the link record.
 * Runs outside the request lifecycle, so every failure is caught and recorded
 * on the link rather than left to bubble.
 *
 * The opt-in agent actions the user ticked at capture time are read off the
 * link's own `repoIntake` field, not passed in — so EVERY path that reaches a
 * successful clone honors them, including the Links tab's Clone/Retry button
 * after a first clone failed. They dispatch only after the clone SUCCEEDS:
 * there is nothing on disk to read before that, and a failed clone must not
 * queue an agent against a path that doesn't exist.
 *
 * Awaiting it awaits only the claim: the `cloning` stamp and a new
 * `cloneAttempt` are one locked write, refused with a 409 when the fresh record
 * is already `cloning`, so two starts run git once. The completion writes only
 * while its attempt still owns the record. Resolves to the claimed link, or
 * null when the link no longer exists.
 */
export async function cloneRepoInBackground(linkId, url) {
  // `ensureInstanceId`, and null rather than the sentinel: `cloneInstanceId`
  // lands on a durable, federated record, and a stamped 'unknown' would read as
  // "some other install owns this" at boot on every machine — re-stranding the
  // exact record this recovery exists to free.
  const resolvedInstanceId = await ensureInstanceId();
  const cloneInstanceId = resolvedInstanceId === UNKNOWN_INSTANCE_ID ? null : resolvedInstanceId;
  const cloneAttempt = uuidv4();
  let inProgress = false;
  let replaceIncomplete = false;
  const claimed = await storage.updateLinkWith(linkId, (fresh) => {
    if (fresh.cloneStatus === 'cloning') {
      inProgress = true;
      return null;
    }
    replaceIncomplete = fresh.cloneInterrupted === true;
    return {
      cloneStatus: 'cloning',
      cloneAttempt,
      // The Links tab renders `cloneError` whenever it is set, independent of
      // status — leaving the previous attempt's message would show the failure
      // text beside the new attempt's spinner.
      cloneError: null,
      cloneInstanceId,
      cloneInterrupted: false
    };
  });
  if (inProgress) {
    throw new ServerError('Clone already in progress', { status: 409, code: 'CLONE_IN_PROGRESS' });
  }
  if (!claimed) return null;

  // A newer attempt (or boot recovery) owns the record once the ids differ; the
  // superseded completion leaves it alone.
  const settle = (updates) => storage.updateLinkWith(linkId, (fresh) => (
    fresh.cloneAttempt === cloneAttempt ? { ...updates, cloneAttempt: null } : null
  ));

  repoCloner.cloneRepo(url, { replaceIncomplete })
    .then(async (result) => {
      const link = await settle({
        localPath: result.localPath,
        cloneStatus: 'cloned',
        cloneError: null,
        cloneInstanceId: null,
        cloneInterrupted: false
      });
      if (!link) {
        console.log(`⏭️ Background clone finished for ${linkId}, but a newer attempt owns the link (or it was deleted)`);
        return;
      }
      console.log(`✅ Background clone complete: ${linkId}`);
      // The whole intake is chained off its OWN catch, so a queueing failure
      // can't rewrite a clone that genuinely succeeded as `failed` via the
      // outer handler below.
      if (!link.repoIntake) return;
      // Load the CoS task graph only when a successful clone requests intake.
      await import('./repoIntake.js')
        .then(({ runRepoIntake }) => runRepoIntake(link, link.repoIntake))
        .then(patch => (Object.keys(patch).length ? storage.updateLink(linkId, patch) : null))
        .catch(err => console.error(`❌ Post-clone intake failed for ${linkId}: ${err.message}`));
    })
    .catch(async (err) => {
      const link = await settle({
        cloneStatus: 'failed',
        cloneError: err.message,
        cloneInstanceId: null,
        cloneInterrupted: false
      }).catch(updateErr => {
        console.error(`❌ Failed to record clone failure for ${linkId}: ${updateErr.message}`);
        return null;
      });
      if (!link) {
        console.log(`⏭️ Superseded clone attempt for ${linkId} ended: ${err.message}`);
        return;
      }
      console.error(`❌ Background clone failed: ${linkId} - ${err.message}`);
    });

  return claimed;
}

/**
 * Create a link from a URL: derives the repository metadata + a readable default
 * title and kicks off the background clone for a repo. Shared by the Links
 * route's quick-add and the bare-URL capture short-circuit so a URL pasted into
 * the Brain inbox lands exactly as it would from the Links tab.
 *
 * Callers own duplicate handling (the route 409s; capture reuses the existing
 * link) — this always creates.
 */
export async function createLinkFromUrl(url, {
  title, description, note, linkType, tags, bucketId, bucketOrder, autoClone, repoIntake
} = {}) {
  const repoFields = deriveRepoLinkFields(url);
  const shouldClone = repoFields.isRepo && autoClone !== false;
  // Opt-in post-clone agent actions. Only meaningful when a clone will actually
  // happen, and persisted on the link so the record says what was asked for even
  // if the clone is still running.
  const intake = shouldClone ? normalizeRepoIntake(repoIntake) : null;

  // Derive a readable default title: repo slug for a repository, hostname for
  // plain URLs (so quick-added bucket chips read "example.com" instead of the
  // full URL).
  const defaultTitle = repoFields.isRepo
    ? `${repoFields.repoOwner}/${repoFields.repoName}`
    : (hostnameFromUrl(url) || url);
  const cleanNote = typeof note === 'string' ? note.trim() : '';

  const link = await storage.createLink({
    url,
    title: title || defaultTitle,
    description: description || '',
    note: cleanNote,
    linkType: linkType || (repoFields.isRepo ? 'repo' : 'other'),
    tags: tags || [],
    ...repoFields,
    localPath: null,
    cloneStatus: shouldClone ? 'pending' : 'none',
    cloneError: null,
    ...(intake ? { repoIntake: intake } : {}),
    ...(bucketId !== undefined ? { bucketId } : {}),
    ...(bucketOrder !== undefined ? { bucketOrder } : {})
  });
  console.log(`🔗 Created link: ${link.id} (${repoFields.isRepo ? `${repoFields.repoHost} repo` : 'regular URL'})`);

  if (shouldClone) {
    cloneRepoInBackground(link.id, url).catch(err => {
      console.error(`❌ Background clone setup failed for ${link.id}: ${err.message}`);
    });
  }

  return link;
}

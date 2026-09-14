/**
 * `.quality.json` — the numeric quality snapshot a repository carries at its
 * root. The file IS a `buildQualitySnapshot` result verbatim
 * (`{ schemaVersion, repository, measurements }`).
 *
 * PortOS's own checkout is not special: it is a managed app like any other, so
 * its release snapshot is this same file, written by this same publisher, under
 * this same per-app `publishQualitySnapshot` toggle.
 *
 * The filename is deliberately generic and PortOS-agnostic: it is generated
 * data any tool can read, not PortOS configuration. Publishing is opt-in per app
 * (`publishQualitySnapshot`), commits only this one path, and never pushes.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../lib/fileCore.js';

export const APP_QUALITY_SNAPSHOT_FILENAME = '.quality.json';
export const APP_QUALITY_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const snapshotPath = repoPath => join(repoPath, APP_QUALITY_SNAPSHOT_FILENAME);
// Byte-identical across every publisher so two files of the same snapshot compare equal.
const serialize = snapshot => `${JSON.stringify(snapshot, null, 2)}\n`;

/** Raw bytes, or null when absent/unreadable/oversize. The publish path needs the
 *  exact text so an unchanged snapshot can skip git entirely. */
async function readSnapshotText(repoPath, deps = {}) {
  if (!repoPath) return null;
  const body = await (deps.readFile || readFile)(snapshotPath(repoPath), 'utf8').catch(() => null);
  if (typeof body !== 'string' || Buffer.byteLength(body) > APP_QUALITY_SNAPSHOT_MAX_BYTES) return null;
  return body;
}

/** Parsed `.quality.json`, or null for every failure mode. Never throws. */
export async function readAppQualitySnapshotFile(repoPath, deps = {}) {
  const body = await readSnapshotText(repoPath, deps);
  if (!body) return null;
  // Inline rather than jsonIo.safeJSONParse: routes/apps/crud.js reaches this
  // module statically, so a lib import here lands in the suite import budget.
  const parsed = await Promise.resolve().then(() => JSON.parse(body)).catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function skipped(app, reason) {
  console.log(`📊 Quality snapshot skipped for app ${app?.id}: ${reason}`);
  return { published: false, reason, path: APP_QUALITY_SNAPSHOT_FILENAME };
}

// One tail per checkout. Several audit categories for the same app finish
// together, and read-modify-write against `.quality.json` plus `.git/index` is
// not re-entrant — the second run must see the first run's bytes (and answer
// `no-changes`) rather than race it. Keyed by repo path, not app id: two app
// records can point at one checkout. Same shape as `issueWriteTail`.
const publishTails = new Map();

/**
 * Rebuild the app's numeric snapshot and commit it into `.quality.json`.
 * An empty snapshot never overwrites a populated file, and an unchanged
 * snapshot never reaches git — an audit that moved nothing leaves no commit.
 */
export async function publishAppQualitySnapshot(app, deps = {}) {
  if (!app?.repoPath) return skipped(app, 'no-repo-path');
  const { repoPath } = app;
  const run = (publishTails.get(repoPath) ?? Promise.resolve())
    .then(() => publishNow(app, deps), () => publishNow(app, deps));
  // The queued value never rejects, so one failed publish cannot poison the tail.
  const queued = run.then(() => {}, () => {});
  publishTails.set(repoPath, queued);
  // Only the newest tail owns the slot; an older one settling must not evict it.
  queued.then(() => { if (publishTails.get(repoPath) === queued) publishTails.delete(repoPath); });
  return run;
}

async function publishNow(app, deps) {
  const git = deps.git || await import('./git.js');
  if (!await git.isRepo(app.repoPath)) return skipped(app, 'not-a-repo');
  const build = deps.buildQualitySnapshot || (await import('./appQualityFederation.js')).buildQualitySnapshot;
  const snapshot = await build(app, 30, deps);
  if (!snapshot?.measurements?.length) return skipped(app, 'no-evidence');

  const body = await readSnapshotText(app.repoPath, deps);
  const next = serialize(snapshot);
  if (next === body) return skipped(app, 'no-changes');

  const count = snapshot.measurements.length;
  await (deps.writeFile || atomicWrite)(snapshotPath(app.repoPath), next);
  await git.stageFiles(app.repoPath, [APP_QUALITY_SNAPSHOT_FILENAME]);
  // A failed commit must not leave the file staged in the user's index, where
  // their next unrelated commit would carry it. Unstage best-effort, then let
  // the original failure surface.
  const { hash } = await git.commit(app.repoPath, `chore: publish PortOS quality snapshot (${count} measurements)`,
    { paths: [APP_QUALITY_SNAPSHOT_FILENAME] })
    .catch(err => git.unstageFiles(app.repoPath, [APP_QUALITY_SNAPSHOT_FILENAME])
      .catch(() => {}).then(() => Promise.reject(err)));
  console.log(`📊 Published quality snapshot for app ${app.id}: ${count} measurements → ${hash}`);
  return { published: true, hash, path: APP_QUALITY_SNAPSHOT_FILENAME };
}

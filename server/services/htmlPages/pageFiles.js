/**
 * HTML Pages bench pages as real files under `data/html-pages/<runId>/<n>-<slug>.html`, so a page can be downloaded or opened by its path.
 *
 * The run record in Postgres stays the source of record and the index: a file is written when its page is saved, and `ensurePageFile` rewrites a missing one (a run stored before files existed, or a file deleted by hand) from the record the first time it is asked for. There is no migration or background backfill. Deleting a run removes its folder.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, ensureDir, PATHS } from '../../lib/fileUtils.js';

// Run ids are minted server-side as `htmlpages-<uuid>`; anything else never reaches a path.
const RUN_ID_RE = /^htmlpages-[0-9a-f-]{36}$/;

const runDir = (runId) => {
  if (!RUN_ID_RE.test(String(runId))) throw new Error(`Not an HTML pages run id: ${runId}`);
  return join(PATHS.htmlPages, runId);
};

/** `3-a-lighthouse-at-dusk.html`: the page number, then a slug of its brief's first line, so a folder listing reads in order. */
export function pageFileName(index, theme) {
  const slug = String(theme || '').split('\n').find((line) => line.trim())?.replace(/^[-*•]\s*/, '')
    .normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'page';
  return `${index + 1}-${slug}.html`;
}

/** Where a run's page lives on this machine. */
export const pageFilePath = (runId, index, theme) => join(runDir(runId), pageFileName(index, theme));

/** Write one page's HTML to its file, replacing a retried page's earlier file. */
export async function writePageFile(runId, index, theme, html) {
  const dir = runDir(runId);
  await ensureDir(dir);
  const name = pageFileName(index, theme);
  // A retried page keeps its number; drop any earlier file for that number whose brief slug differed.
  const stale = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(`${index + 1}-`) && f !== name);
  await Promise.all(stale.map((f) => rm(join(dir, f), { force: true })));
  const path = join(dir, name);
  await atomicWrite(path, html);
  return path;
}

/** The file for page `index` of a stored run, written from the record first when it is missing. Null for a page with no HTML. */
export async function ensurePageFile(run, index) {
  const page = run?.pages?.[index];
  if (!page?.html) return null;
  const path = pageFilePath(run.id, index, page.theme);
  const present = await readdir(runDir(run.id)).then((files) => files.includes(pageFileName(index, page.theme))).catch(() => false);
  return present ? path : writePageFile(run.id, index, page.theme, page.html);
}

/** Remove a run's folder; a run that never had files is not an error. */
export const removeRunFiles = (runId) => rm(runDir(runId), { recursive: true, force: true });

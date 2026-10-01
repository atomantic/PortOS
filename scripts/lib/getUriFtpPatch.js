/**
 * Install-time patch for get-uri's FTP adapter (#9462).
 *
 * get-uri decides "does this file exist, and when did it change" from
 * `client.lastMod()` (MDTM), then falls back to `client.list()` and reads
 * `entry.modifiedAt`. basic-ftp only fills `modifiedAt` from MLSD; its Unix
 * `LIST` parser sets `rawModifiedAt` and nothing else. A server without MDTM
 * *and* without MLSD therefore makes an existing file look missing (ENOTFOUND).
 * Upstream get-uri (through 8.0.1) still reads only `modifiedAt`, so we carry
 * the fallback ourselves. `ignore-scripts=true` blocks a postinstall hook, so
 * this runs from scripts/trusted-rebuilds.js — the same place every managed
 * install path already calls — against each workspace's installed tree.
 *
 * Raw date contract (basic-ftp `parseListUnix.js`): `rawModifiedAt` is
 * `"<date> <year-or-time>"`, one of
 *   `Mon d yyyy` / `Mon d hh:mm`   (ls -l: year for old files, time for recent)
 *   `d Mon yyyy` / `d Mon hh:mm`
 *   `yyyy-mm-dd hh:mm`             (also with `/`)
 * LIST carries no timezone. We read every value as UTC, the same zone MDTM and
 * MLSD use, so the result is deterministic and never depends on the host's
 * locale. A year-less value (`Mon d hh:mm`) takes the most recent year that
 * does not put the date more than a day in the future. The year form has day
 * resolution only, so it is midnight UTC. Anything else (non-English month
 * names, Japanese forms, an out-of-range day) throws `EFTPLISTDATE` rather
 * than inventing a timestamp. Cache validation compares exact instants, so a
 * listing that later flips from the time form to the year form just redownloads.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const GET_URI_PATCH_TARGET_VERSION = '6.0.5';
const MARKER_BEGIN = '/* portos-patch #9462 begin';
const MARKER_END = '/* portos-patch #9462 end */\n';

const ANCHOR = 'lastModified = entry.modifiedAt;';
const HELPER_ANCHOR = 'const ftp = ';
const PATCHED = 'lastModified = entry.modifiedAt ?? parseUnixListDate(entry.rawModifiedAt);';

/**
 * Self-contained on purpose: `applyGetUriFtpPatch` injects this function's own
 * source into get-uri's CommonJS file, so it may reference nothing outside its body.
 * Returns a Date, or throws an Error with code `EFTPLISTDATE`.
 */
export function parseUnixListDate(raw, now = Date.now()) {
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const fail = () => Object.assign(
    new Error(`Unsupported FTP LIST modified date ${JSON.stringify(String(raw))}`),
    { code: 'EFTPLISTDATE' }
  );
  const build = (year, month, day, hour, minute) => {
    const date = new Date(Date.UTC(year, month, day, hour, minute));
    // Date.UTC rolls Feb 30 into March; a round-trip mismatch means the input was invalid.
    const valid = hour < 24 && minute < 60 && date.getUTCFullYear() === year
      && date.getUTCMonth() === month && date.getUTCDate() === day;
    return valid ? date : null;
  };
  const text = String(raw ?? '').trim();
  let month;
  let day;
  let tail;
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (match) {
    const date = build(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
    if (!date) throw fail();
    return date;
  }
  if ((match = text.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}|\d{1,2}:\d{2})$/))) {
    [, month, day, tail] = match;
  } else if ((match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}|\d{1,2}:\d{2})$/))) {
    [, day, month, tail] = match;
  } else {
    throw fail();
  }
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  if (monthIndex === -1) throw fail();
  if (!tail.includes(':')) {
    const date = build(+tail, monthIndex, +day, 0, 0);
    if (!date) throw fail();
    return date;
  }
  const [hour, minute] = tail.split(':').map(Number);
  const limit = now + 24 * 60 * 60 * 1000;
  // Walk back a few years so Feb 29 resolves to the latest leap year instead of failing.
  for (let year = new Date(limit).getUTCFullYear(), i = 0; i < 5; i += 1, year -= 1) {
    const date = build(year, monthIndex, +day, hour, minute);
    if (date && +date <= limit) return date;
  }
  throw fail();
}

/** Changes whenever the injected code or its target does — see trusted-rebuild-stamp.js. */
export const patchFingerprint = () => createHash('sha256')
  .update([GET_URI_PATCH_TARGET_VERSION, ANCHOR, PATCHED, parseUnixListDate.toString()].join('\0'))
  .digest('hex')
  .slice(0, 16);

// Reverts a previously injected patch so a changed patch replaces it instead of
// stacking on (or being skipped behind) the old one.
const stripPatch = (source) => {
  const start = source.indexOf(MARKER_BEGIN);
  const end = source.indexOf(MARKER_END);
  const base = start !== -1 && end > start
    ? source.slice(0, start) + source.slice(end + MARKER_END.length)
    : source;
  return base.replace(/lastModified = entry\.modifiedAt \?\? parseUnixListDate\([^;]*\);/, ANCHOR);
};

/**
 * Patch `<nodeModulesDir>/get-uri/dist/ftp.js` in place. Idempotent, and a
 * changed patch replaces the one an earlier install injected. Returns `absent`
 * (get-uri not installed here), `patched`, `already-patched`, or
 * `unrecognized` (a get-uri this patch was not written for — never edited blind).
 */
export function applyGetUriFtpPatch(nodeModulesDir) {
  const file = join(nodeModulesDir, 'get-uri', 'dist', 'ftp.js');
  if (!existsSync(file)) return 'absent';
  const installed = readFileSync(file, 'utf8');
  const fingerprint = patchFingerprint();
  if (installed.includes(`${MARKER_BEGIN} ${fingerprint} */`)) return 'already-patched';
  const source = stripPatch(installed);
  if (!source.includes(ANCHOR) || !source.includes(HELPER_ANCHOR)) return 'unrecognized';
  const helper = `${MARKER_BEGIN} ${fingerprint} */\n${parseUnixListDate.toString()}\n${MARKER_END}`;
  const patched = source.replace(ANCHOR, PATCHED).replace(HELPER_ANCHOR, `${helper}${HELPER_ANCHOR}`);
  writeFileSync(file, patched);
  return 'patched';
}

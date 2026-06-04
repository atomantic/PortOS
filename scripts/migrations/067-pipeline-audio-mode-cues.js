/**
 * Stamp `stages.audio.audioMode` + initialize `stages.audio.cues[]` on existing
 * pipeline issues (whole-episode audio — issue #863, design doc
 * docs/plans/2026-06-03-whole-episode-audio-strategy.md).
 *
 * Back-compat derivation (preserve today's behavior — never let "absent"
 * collapse into a wrong mode):
 *   - audio.music present  → 'uploaded-track'  (the install has a single bed
 *                            it loops under the whole episode today)
 *   - audio.music absent   → 'per-clip'        (today's "no bed, keep each
 *                            clip's own soundtrack" behavior)
 *   - cues initialized to []
 *
 * The read-side sanitizer (`sanitizeAudioMode`) already defaults an absent
 * audioMode to 'per-clip', so an un-migrated or older-peer-synced record reads
 * correctly before this runs; the migration just makes the stored value
 * explicit (and stamps 'uploaded-track' where a track already exists, which the
 * read-side default alone can't infer).
 *
 * Issues live per-record under `data/pipeline-issues/{id}/index.json` after the
 * 035 split (which runs before this migration). Idempotent: a record that
 * already carries an `audioMode` is left untouched.
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';

const readJsonOrNull = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJson = async (path, data) => {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
};

// Apply the audioMode/cues stamp to one issue record in place. Returns true if
// the record was changed.
const stampIssue = (issue) => {
  if (!issue || typeof issue.stages !== 'object' || issue.stages === null) return false;
  const audio = issue.stages.audio;
  if (!audio || typeof audio !== 'object') return false;
  let changed = false;
  if (!('audioMode' in audio)) {
    const hasTrack = audio.music && typeof audio.music === 'object';
    audio.audioMode = hasTrack ? 'uploaded-track' : 'per-clip';
    changed = true;
  }
  if (!Array.isArray(audio.cues)) {
    audio.cues = [];
    changed = true;
  }
  return changed;
};

const listIssueDirs = async (typeDir) => {
  const entries = await readdir(typeDir).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (entries == null) return [];
  const dirs = [];
  for (const name of entries) {
    if (name === 'index.json') continue;
    const full = join(typeDir, name);
    const st = await stat(full).catch(() => null);
    if (st?.isDirectory()) dirs.push(full);
  }
  return dirs;
};

export default {
  async up({ rootDir }) {
    const typeDir = join(rootDir, 'data', 'pipeline-issues');
    const dirs = await listIssueDirs(typeDir);
    if (dirs.length === 0) {
      console.log('🎵 audio-mode: no pipeline issues — nothing to do (fresh installs seed audioMode on create)');
      return;
    }

    let touched = 0;
    for (const dir of dirs) {
      const recordPath = join(dir, 'index.json');
      const issue = await readJsonOrNull(recordPath);
      if (!issue) continue;
      if (stampIssue(issue)) {
        await writeJson(recordPath, issue);
        touched += 1;
      }
    }

    if (touched > 0) {
      console.log(`📝 audio-mode: stamped audioMode + cues[] on ${touched} issue${touched === 1 ? '' : 's'}`);
    } else {
      console.log('✅ audio-mode: all issues already carry audioMode — nothing to do');
    }
  },
};

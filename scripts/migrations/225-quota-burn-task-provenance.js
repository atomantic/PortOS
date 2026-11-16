/**
 * Migration 225 — stamp `quotaBurnFamily` onto burn tasks queued before it existed.
 *
 * A quota-burn dispatch queues an ordinary CoS task (`quotaBurnJobs/agentPrompt.js`) that the spawn scheduler used to subject to the per-app REVIEW COOLDOWN (30 minutes, re-stamped by every completing task on that app),
 * which never lapses on an app with other recurring work, so the burn sat in Pending until its window reset unspent. Burn tasks are now exempt (`isCooldownExemptTask` in `server/services/cosTaskGenerator.js`) and
 * `quotaBurnRunner.js` advances the family's plan on completion; both recognise a burn by `metadata.quotaBurnFamily`, stamped at queue time, but nothing rewrites tasks already on disk. An unstamped stranded burn also
 * REJECTS its own re-dispatch (`addTask` dedupes on first-line description + app), making that plan job permanently unreachable.
 *
 * Writes `data/COS-TASKS.md`: one `  - quotaBurnFamily: <id>` metadata line directly under each `[Quota burn: <family>] …` task lacking it, in every section (the marker is provenance).
 * A text-level insert rather than a parse/regenerate round-trip (as in migration 146): regenerating would reorder and re-escape every task, so a bug in an unrelated metadata value would be written over the user's live list.
 *
 * Idempotent: a task that already carries the key is skipped; the file is untouched when there is nothing to do.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { quotaBurnFamilyOfDescription } from '../../server/lib/quotaBurnConfig.js';

// The task header line, per `server/lib/legacyTaskMarkdown.js`. Both spellings — with
// and without the AUTO/APPROVAL flag — since internal tasks carry it and the
// legacy shape does not.
const TASK_LINE = /^-\s*\[([ x~!?])\]\s*#([\w-]+)\s*\|\s*(?:CRITICAL|HIGH|MEDIUM|LOW)\s*\|\s*(?:(?:AUTO|APPROVAL)\s*\|\s*)?(.+)$/i;
const METADATA_LINE = /^\s+-\s*(\w+):/;

/**
 * Insert the missing `quotaBurnFamily` metadata line under every burn task.
 * Pure — exported for the test.
 * @param {string} markdown raw COS-TASKS.md
 * @returns {{ markdown: string, stamped: string[] }} stamped task ids
 */
export function stampBurnTaskProvenance(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  const stamped = [];

  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const header = lines[i].match(TASK_LINE);
    if (!header) continue;
    const family = quotaBurnFamilyOfDescription(header[3].trim());
    if (!family) continue;

    // Look ahead over this task's own metadata block only — it ends at the next
    // line that is not an indented `- key: value`, which is the next task, a
    // section heading, or a blank line.
    let hasKey = false;
    for (let j = i + 1; j < lines.length; j++) {
      const meta = lines[j].match(METADATA_LINE);
      if (!meta) break;
      if (meta[1] === 'quotaBurnFamily') { hasKey = true; break; }
    }
    if (hasKey) continue;

    out.push(`  - quotaBurnFamily: ${family}`);
    stamped.push(header[2]);
  }

  return { markdown: out.join('\n'), stamped };
}

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'COS-TASKS.md');
    const raw = await readFile(file, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log('🔥 migration 225: no data/COS-TASKS.md — nothing to stamp');
      return { ok: true, reason: 'no-task-file' };
    }

    const { markdown, stamped } = stampBurnTaskProvenance(raw);
    if (!stamped.length) {
      console.log('🔥 migration 225: no unstamped quota-burn tasks');
      return { ok: true, reason: 'already-stamped', stamped: 0 };
    }

    const tmp = `${file}.tmp-225`;
    await writeFile(tmp, markdown);
    await rename(tmp, file);
    console.log(`🔥 migration 225: stamped quotaBurnFamily on ${stamped.length} quota-burn task(s)`);
    return { ok: true, stamped: stamped.length };
  },
};

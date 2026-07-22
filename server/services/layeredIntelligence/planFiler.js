/**
 * Layered Intelligence — PLAN.md filer (#2842 split of layeredIntelligence.js).
 * The tracker path for apps with no issue tracker: slug-tagged checklist items
 * appended under `## Next Up`.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile, appendFile } from 'fs/promises';

/**
 * Append a slug-tagged proposal to the app's PLAN.md (the `plan` tracker path).
 * Dedups by scanning for the `[lil-<slug>]` tag. Creates PLAN.md with a heading
 * + `## Next Up` section if absent. Returns `{ success, duplicate }`.
 */
export async function appendProposalToPlan({ repoPath, appName, slug, title, body } = {}) {
  const planPath = join(repoPath, 'PLAN.md');
  const tag = `[lil-${slug}]`;
  const existing = existsSync(planPath) ? await readFile(planPath, 'utf-8').catch(() => '') : '';
  if (existing.includes(tag)) return { success: true, duplicate: true };

  const oneLine = (body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const item = `- [ ] ${tag} **${title}** ${oneLine}`.trim();

  if (!existing) {
    const content = `# ${appName} — Development Plan\n\n## Next Up\n\n${item}\n`;
    await writeFile(planPath, content);
    return { success: true, duplicate: false };
  }
  const nextUpRe = /(##\s+Next Up[^\n]*)(\n?)/;
  if (nextUpRe.test(existing)) {
    // Insert right after the "## Next Up" heading line, normalizing the heading's
    // line ending first so a file that ENDS at `## Next Up` (no trailing newline)
    // gets the item on its own line rather than a second section appended below.
    const updated = existing.replace(nextUpRe, `$1\n${item}\n`);
    await writeFile(planPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return { success: true, duplicate: false };
  }
  // No Next Up section — append one.
  const sep = existing.endsWith('\n') ? '' : '\n';
  await appendFile(planPath, `${sep}\n## Next Up\n\n${item}\n`);
  return { success: true, duplicate: false };
}

/**
 * Scan a PLAN.md string for `[lil-<slug>]` tags → array of `{ slug, state }`.
 * Preserves each tag's list-item checkbox so the outcome loop (#2435) can
 * reconcile a completed PLAN proposal: `- [x] [lil-foo]` reads as `closed`,
 * `- [ ] [lil-foo]` as `open`.
 *
 * Absent ≠ done (the CLAUDE.md sentinel rule): a bare tag with NO preceding
 * checkbox stays `open` (still tracked/suppressed) rather than collapsing to
 * `closed` — a missing checkbox must not silently make an item re-proposable.
 * A `closed` item carries no `closedAt` (PLAN.md checkboxes have no timestamp),
 * which `isIssueWithinDedupWindow` treats as permanently in-window → a completed
 * proposal stays suppressed forever instead of being re-reasoned every run (#2620).
 */
export function extractPlanSlugs(planContent) {
  if (typeof planContent !== 'string') return [];
  const items = [];
  // Alt 1: a list item `- [ ]`/`- [x]` whose line also carries the tag (state
  // from the checkbox char). Alt 2: a bare tag with no checkbox (state 'open').
  const re = /^[ \t]*[-*][ \t]*\[([ xX])\][^\n]*?\[lil-([a-z0-9][a-z0-9-]*)\]|\[lil-([a-z0-9][a-z0-9-]*)\]/gim;
  let m;
  while ((m = re.exec(planContent))) {
    if (m[2]) {
      items.push({ slug: m[2].toLowerCase(), state: m[1].toLowerCase() === 'x' ? 'closed' : 'open' });
    } else {
      items.push({ slug: m[3].toLowerCase(), state: 'open' });
    }
  }
  return items;
}

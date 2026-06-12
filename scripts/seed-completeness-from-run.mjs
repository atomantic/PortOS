/**
 * One-off recovery: seed a manuscript-completeness review from a TUI run whose
 * result was captured to tui-response.txt but never seeded (the run was marked
 * timed-out and a useless fallback ran instead). Reuses the real
 * seedReviewFromFindings so dedup, issueId resolution, and fix-backfill match
 * exactly what the pipeline would have done.
 *
 * Usage: node scripts/seed-completeness-from-run.mjs <seriesId> <runId> [--dry]
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { collectManuscriptSections } from '../server/services/pipeline/arcPlanner.js';
import { seedReviewFromFindings, getReview } from '../server/services/pipeline/manuscriptReview.js';
import { getRunsPath } from '../server/services/runner.js';

const [seriesId, runId] = process.argv.slice(2);
const dry = process.argv.includes('--dry');
if (!seriesId || !runId) {
  console.error('usage: node scripts/seed-completeness-from-run.mjs <seriesId> <runId> [--dry]');
  process.exit(1);
}

// Resolve via the runner's own runs-path helper (honors a non-default dataDir)
// rather than hardcoding ./data, matching where the TUI runner wrote the file.
const responsePath = join(getRunsPath(), runId, 'tui-response.txt');
const parsed = JSON.parse(readFileSync(responsePath, 'utf8'));
const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
console.log(`📥 ${issues.length} findings in ${responsePath}`);

const sections = await collectManuscriptSections(seriesId);
console.log(`📑 ${sections.length} manuscript sections resolved for ${seriesId}`);
if (!sections.length) {
  console.error('❌ no manuscript sections — issueId/fix resolution would be empty. Aborting (check seriesId / data root).');
  process.exit(1);
}

const before = await getReview(seriesId);
const beforeOpen = before.comments.filter((c) => c.status === 'open').length;
console.log(`📊 before: ${before.comments.length} comments (${beforeOpen} open)`);

if (dry) {
  console.log('🧪 dry run — not writing. Findings preview:');
  for (const i of issues) console.log(`  #${i.issueNumber} [${i.severity}/${i.category}] ${i.replacementStrategy} ${i.replace ? '(has replace)' : ''} — ${(i.location || '').slice(0, 50)}`);
  process.exit(0);
}

const review = await seedReviewFromFindings(seriesId, issues, { runId, mode: 'merge' });
const after = review.comments.length;
const afterOpen = review.comments.filter((c) => c.status === 'open').length;
const fromThisRun = review.comments.filter((c) => c.sourceRunId === runId).length;
const withFix = review.comments.filter((c) => c.sourceRunId === runId && c.fix).length;
console.log(`✅ after: ${after} comments (${afterOpen} open). Added ${after - before.comments.length} new; ${fromThisRun} tagged to run ${runId.slice(0, 8)} (${withFix} with pre-built fix).`);
process.exit(0);

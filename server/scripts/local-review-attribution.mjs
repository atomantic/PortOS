#!/usr/bin/env node
import { resetLocalReviewAttribution, recordLocalReviewAttribution, localReviewAttributionLabels } from '../lib/localReviewAttribution.js';
import { formatLabelCreateCommand } from '../lib/dispatchLabels.js';

// Reviewer labels are best-effort and nothing reads them back (#16571): an unreadable or unwritable receipt skips
// the labels and exits 0 so it can never block a review or a publication. Only a bad action is a usage error.
const [action, cli = 'gh'] = process.argv.slice(2);
if (!['reset', 'record-cli', 'labels'].includes(action)) {
  process.stderr.write('Expected reset, record-cli, or labels\n');
  process.exit(1);
}
try {
  if (action === 'reset') await resetLocalReviewAttribution(process.cwd());
  else if (action === 'record-cli') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await recordLocalReviewAttribution(process.cwd(), JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } else {
    const labels = await localReviewAttributionLabels(process.cwd());
    process.stdout.write(`${JSON.stringify({ labels, createCommands: labels.map(label => formatLabelCreateCommand(label, { cli })) })}\n`);
  }
} catch {
  if (action === 'labels') process.stdout.write(`${JSON.stringify({ labels: [], createCommands: [], skipped: true })}\n`);
}

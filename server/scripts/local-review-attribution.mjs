#!/usr/bin/env node
import { resetLocalReviewAttribution, recordLocalReviewAttribution, localReviewAttributionLabels } from '../lib/localReviewAttribution.js';
import { formatLabelCreateCommand } from '../lib/dispatchLabels.js';

try {
  const [action, cli = 'gh'] = process.argv.slice(2);
  if (action === 'reset') await resetLocalReviewAttribution(process.cwd());
  else if (action === 'record-cli') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await recordLocalReviewAttribution(process.cwd(), JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } else if (action === 'labels') {
    const labels = await localReviewAttributionLabels(process.cwd());
    process.stdout.write(`${JSON.stringify({ labels, createCommands: labels.map(label => formatLabelCreateCommand(label, { cli })) })}\n`);
  } else throw new Error('Expected reset, record-cli, or labels');
} catch {
  process.stderr.write('Unable to read or persist local review attribution; stop publication and inspect the worktree evidence.\n');
  process.exitCode = 1;
}

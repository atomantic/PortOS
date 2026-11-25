import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readGithubLinkedWork } from '../server/lib/issueClaimEvidence.js';

const execFileAsync = promisify(execFile);
const [host, repo, issueNumber] = process.argv.slice(2);
const items = host ? await readGithubLinkedWork({
  host, repo, issueNumber,
  readGh: async args => (await execFileAsync('gh', args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })).stdout,
}) : null;

process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);

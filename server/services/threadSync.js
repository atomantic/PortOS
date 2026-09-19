/**
 * Discover assigned issues as Brain threads (tracked topics, NOT message threads).
 * Explicit requests only: this module never schedules work or calls an AI provider.
 * Missing rows are not evidence of closure: a bounded query can omit unassigned
 * or older items. Only a positively observed CLOSED issue changes externalState.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { threadInputSchema } from '../lib/brainValidation.js';
import * as brainStorage from './brainStorage.js';

const LIMIT = 200;
const inFlight = new Map();
const issueRowsSchema = z.array(z.object({
  number: z.number().int().positive(),
  title: z.string().trim().min(1),
  state: z.enum(['OPEN', 'CLOSED']),
}));

function probeFailure() {
  return new ServerError('Could not read assigned GitHub issues; existing threads were left untouched', {
    status: 502, code: 'THREAD_SYNC_FAILED',
  });
}

async function runSync({ appId, pinned }) {
  const { getAppById } = await import('./apps.js');
  const { resolveAppForgeTarget } = await import('../lib/workTracker.js');
  const { resolveForgeExecOptions } = await import('./forgeExecOptions.js');
  const { execGh, ensureForgeReachable } = await import('./github.js');
  const app = await getAppById(appId);
  if (!app) throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  const { tracker, target } = await resolveAppForgeTarget(app);
  if (tracker !== 'github' || target?.forge !== 'github') {
    throw new ServerError('Select an app whose work tracker is GitHub', {
      status: 400, code: 'UNSUPPORTED_TRACKER',
    });
  }
  const { cwd, env, customEnv } = await resolveForgeExecOptions(app.repoPath, {
    forgeAccount: app.forgeAccount,
  });
  const reachable = await ensureForgeReachable('thread-sync', {
    hostname: target.apiHost,
    ...(customEnv ? { env: customEnv } : {}),
  });
  if (!reachable.ok) throw probeFailure();
  const raw = await execGh([
    'issue', 'list', '--repo', target.repoSpec, '--assignee', '@me',
    '--state', 'all', '--limit', String(LIMIT), '--json', 'number,title,state',
  ], undefined, { cwd, env }).catch(() => null);
  const parsed = issueRowsSchema.safeParse(safeJSONParse(raw, null));
  if (!parsed.success) throw probeFailure();

  // Validate the entire probe before the first write. Identity includes the
  // forge host and full repository name; punctuation cannot cause slug
  // collisions, and enterprise instances cannot alias github.com.
  const repoKey = target.repoSpec.toLowerCase();
  const rows = [...new Map(parsed.data.map(row => [row.number, row])).values()];
  const result = { observed: rows.length, created: 0, updated: 0, skipped: 0, possiblyTruncated: rows.length === LIMIT };
  for (const issue of rows) {
    const key = JSON.stringify([repoKey, issue.number]);
    const id = `gh-${createHash('sha256').update(key).digest('hex')}`;
    const ref = {
      kind: 'github.issue',
      id: `https://${target.apiHost}/${target.fullName}/issues/${issue.number}`,
      label: issue.title.slice(0, 300),
    };
    const externalState = issue.state === 'OPEN' ? 'open' : 'closed';
    const source = { kind: ref.kind, key };
    if (externalState === 'open') {
      const created = await brainStorage.upsertWithId('threads', id, {
        ...threadInputSchema.parse({ title: issue.title.slice(0, 200), pinned, refs: [ref] }),
        source, externalState, closedAt: null,
      }, { createOnly: true });
      if (created) {
        result.created++;
        continue;
      }
    }
    // Merge inside the store queue. Human fields, unknown peer fields,
    // detached refs, and tombstones remain untouched.
    const updated = await brainStorage.updateWith('threads', id, fresh => {
      if (fresh.source?.kind !== source.kind || fresh.source?.key !== key) return null;
      const refs = Array.isArray(fresh.refs) ? fresh.refs : [];
      const changedLabel = refs.some(r => r.kind === ref.kind && r.id === ref.id && r.label !== ref.label);
      if (fresh.externalState === externalState && !changedLabel) return null;
      return {
        externalState,
        ...(changedLabel ? { refs: refs.map(r => r.kind === ref.kind && r.id === ref.id ? { ...r, label: ref.label } : r) } : {}),
      };
    });
    if (updated) result.updated++;
    else result.skipped++;
  }
  return result;
}

/** Repeated requests for the same app share one in-flight ingestion. */
export function syncGithubThreads(input) {
  if (inFlight.has(input.appId)) return inFlight.get(input.appId);
  const pending = runSync(input).finally(() => inFlight.delete(input.appId));
  inFlight.set(input.appId, pending);
  return pending;
}

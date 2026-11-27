import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attributeMtplxRequest, awaitMtplxRequest, mtplxRequestLogPath } from './mtplxRequestLog.js';

let dir;
let args;

const record = (overrides = {}) => ({
  request_id: 'request-1',
  logged_at_s: 101,
  request_model: 'example-model',
  request_cancelled: true,
  completion_tokens: 12,
  ...overrides,
});
const line = (overrides) => `${JSON.stringify(record(overrides))}\n`;
const matched = { status: 'matched', requestId: 'request-1', completionTokens: 12 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'portos-mtplx-log-'));
  args = {
    logPath: join(dir, 'request-log.jsonl'),
    startedAtMs: 100_000,
    endedAtMs: 102_000,
    model: 'example-model',
  };
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it('derives the per-port log under the explicit, configured, or default home', () => {
  vi.stubEnv('MTPLX_HOME', dir);
  expect(mtplxRequestLogPath(9000)).toBe(join(dir, 'logs', 'request-log-9000.jsonl'));
  const other = join(dir, 'other');
  expect(mtplxRequestLogPath(9001, other)).toBe(join(other, 'logs', 'request-log-9001.jsonl'));
  vi.stubEnv('MTPLX_HOME', '');
  expect(mtplxRequestLogPath(9000)).toBe(join(homedir(), '.mtplx', 'logs', 'request-log-9000.jsonl'));
});

it.each([99, 132])('includes a request at the window edge (%ss)', async (logged_at_s) => {
  await writeFile(args.logPath,
    `{malformed}\n${line({ logged_at_s: 98.999, request_id: 'too-early' })}`
    + line({ logged_at_s: 132.001, request_id: 'too-late' })
    + line({ logged_at_s, request_elapsed_s: logged_at_s - 99 })
  );
  expect(await attributeMtplxRequest(args)).toEqual(matched);
});

it.each(['inside a line', 'at the start of a line'])('reads a 4 MiB tail beginning %s', async (cut) => {
  const tailBytes = 4 * 1024 * 1024;
  const current = line();
  // Beyond the cap, this in-window request would make attribution ambiguous.
  const outside = line({ request_id: 'outside-tail' });
  const fragment = cut === 'inside a line' ? line({ request_id: 'line-fragment' }) : '';
  const padding = ' '.repeat(tailBytes - Buffer.byteLength(current + fragment));
  const prefix = fragment ? 'truncated-prefix:' : '';
  await writeFile(args.logPath, outside + prefix + fragment + current + padding);

  expect(await attributeMtplxRequest(args)).toEqual(matched);
});

it('coalesces cancellation and metrics for one request and returns only identity and the maximum valid counter', async () => {
  await writeFile(args.logPath, line({
    request_cancelled: false, stream_cancelled_by_client: true, completion_tokens: -1,
    generated_tokens: 18, prompt_preview: 'synthetic prompt', reasoning: 'synthetic reasoning',
  }) + line({ request_cancelled: false, completion_tokens: '25', streamed_completion_tokens: 22 }));

  expect(await attributeMtplxRequest(args)).toEqual({ ...matched, completionTokens: 22 });
});

it.each([
  ['concurrent requests', [{}, { request_id: 'request-2' }]],
  ['concurrent requests', [{ request_id: null }, { request_id: null }]],
  ['request began before the run', [{ request_elapsed_s: 3 }]],
  ['request began before the run', [{}, { request_elapsed_s: 3 }]],
  ['request names a different model', [{ request_model: 'other-model' }]],
  ['request names a different model', [{}, { request_model: 'other-model' }]],
  ['request was not cancelled by the run', [{ request_cancelled: false }]],
])('refuses attribution for %s (%#)', async (reason, records) => {
  await writeFile(args.logPath, records.map(line).join(''));
  expect(await attributeMtplxRequest(args)).toEqual({ status: 'unattributed', reason });
});

it('ignores a different request that began before the run even if its line landed inside the window', async () => {
  await writeFile(args.logPath, line({ request_id: 'earlier', request_elapsed_s: 3 }) + line());
  expect(await attributeMtplxRequest(args)).toEqual(matched);
});

it('re-reads an initially empty log and finds a late cancellation on the next attempt', async () => {
  await writeFile(args.logPath, '');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const result = awaitMtplxRequest(args, { attempts: 2, delayMs: 500 });

  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
  await appendFile(args.logPath, line({ logged_at_s: 105 }));
  await vi.advanceTimersByTimeAsync(500);

  expect(await result).toEqual(matched);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops polling when the attempt budget is exhausted', async () => {
  await writeFile(args.logPath, '');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const result = awaitMtplxRequest(args, { attempts: 2, delayMs: 500 });

  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
  await vi.advanceTimersByTimeAsync(500);

  expect(await result).toEqual({ status: 'unattributed', reason: 'no request in window' });
  expect(vi.getTimerCount()).toBe(0);
});

it('does not schedule retries for an unreadable log or ambiguous attribution', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect(await awaitMtplxRequest(args)).toEqual({ status: 'unavailable', reason: 'request log unreadable' });
  await writeFile(args.logPath, line() + line({ request_id: 'request-2' }));
  expect(await awaitMtplxRequest(args)).toEqual({ status: 'unattributed', reason: 'concurrent requests' });
  expect(vi.getTimerCount()).toBe(0);
});

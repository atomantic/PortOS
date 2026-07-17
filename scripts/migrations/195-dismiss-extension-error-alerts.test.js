import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './195-dismiss-extension-error-alerts.js';

let rootDir;

const ITEMS_REL = 'data/review/items.json';

async function seed(items) {
  await mkdir(join(rootDir, 'data', 'review'), { recursive: true });
  await writeFile(join(rootDir, ITEMS_REL), JSON.stringify(items, null, 2));
}

async function readItems() {
  return JSON.parse(await readFile(join(rootDir, ITEMS_REL), 'utf-8'));
}

// Mirrors `buildDescription`: header block, blank line, then the stack.
const describeAlert = ({ url, source, stack }) =>
  [`URL: ${url}`, ...(source ? [`Source: ${source}`] : []), 'UA: TestAgent', 'Type: unhandledrejection', '', stack]
    .join('\n');

const alert = (overrides = {}) => ({
  id: 'item-1',
  type: 'alert',
  status: 'pending',
  title: 'Unhandled rejection: boom',
  description: describeAlert({ url: 'https://portos/dashboard', stack: 'Error: boom\n    at f (/assets/index.js:1:1)' }),
  metadata: { category: 'client-error', kind: 'unhandledrejection', referenceId: 'client-error:abc' },
  ...overrides,
});

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-mig195-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('195-dismiss-extension-error-alerts', () => {
  it('dismisses an alert whose stack has an extension frame', async () => {
    await seed([alert({
      title: 'Unhandled rejection: Cannot read properties of null',
      description: describeAlert({
        url: 'https://portos/dashboard',
        stack: 'TypeError\n    at inject (chrome-extension://abcdef/inpage.js:1:1)',
      }),
    })]);

    const result = await migration.up({ rootDir });

    expect(result.dismissed).toBe(1);
    expect((await readItems())[0].status).toBe('dismissed');
  });

  it('dismisses a stackless MetaMask rejection via its message', async () => {
    await seed([alert({
      title: 'Unhandled rejection: Failed to connect to MetaMask',
      description: describeAlert({ url: 'https://portos/cos', stack: '' }),
    })]);

    expect((await migration.up({ rootDir })).dismissed).toBe(1);
  });

  it('does NOT dismiss `crypto.randomUUID is not a function` — that is our own bug', async () => {
    // The regression that matters: this alert looks like extension noise but is
    // PortOS crashing on an insecure origin. Retroactively hiding it would bury
    // a real bug the user needs to see.
    await seed([alert({
      title: 'Unhandled rejection: crypto.randomUUID is not a function',
      description: describeAlert({
        url: 'http://example-host.ts.net:5554/apps/demo',
        stack: 'TypeError\n    at add (http://example-host.ts.net:5554/assets/index.js:9:9)',
      }),
    })]);

    const result = await migration.up({ rootDir });

    expect(result.dismissed).toBe(0);
    expect((await readItems())[0].status).toBe('pending');
  });

  it('never matches on the page URL alone', async () => {
    // `url` is window.location.href — ours even when an extension throws on it.
    // The header block must stay out of the matcher.
    await seed([alert({
      description: describeAlert({
        url: 'https://portos/apps/chrome-extension://spoof',
        stack: 'Error: boom\n    at f (/assets/index.js:1:1)',
      }),
    })]);

    expect((await migration.up({ rootDir })).dismissed).toBe(0);
  });

  it('leaves already-triaged and non-client-error items alone', async () => {
    const extensionStack = 'TypeError\n    at inject (chrome-extension://abcdef/inpage.js:1:1)';
    await seed([
      alert({ id: 'a', status: 'completed', description: describeAlert({ url: 'https://portos/x', stack: extensionStack }) }),
      alert({ id: 'b', status: 'dismissed', description: describeAlert({ url: 'https://portos/x', stack: extensionStack }) }),
      alert({ id: 'c', metadata: { category: 'todo' }, description: describeAlert({ url: 'https://portos/x', stack: extensionStack }) }),
    ]);

    const result = await migration.up({ rootDir });

    expect(result.dismissed).toBe(0);
    const items = await readItems();
    expect(items.map(i => i.status)).toEqual(['completed', 'dismissed', 'pending']);
  });

  it('is a no-op that does not rewrite the file when nothing matches', async () => {
    await seed([alert()]);
    const before = await readFile(join(rootDir, ITEMS_REL), 'utf-8');

    expect((await migration.up({ rootDir })).dismissed).toBe(0);
    expect(await readFile(join(rootDir, ITEMS_REL), 'utf-8')).toBe(before);
  });

  it('tolerates a missing items file', async () => {
    expect(await migration.up({ rootDir })).toEqual({ dismissed: 0, reason: 'no-file' });
  });

  it('skips an unparseable or unexpectedly-shaped items file rather than destroying it', async () => {
    await mkdir(join(rootDir, 'data', 'review'), { recursive: true });
    await writeFile(join(rootDir, ITEMS_REL), '{not json');
    expect((await migration.up({ rootDir })).reason).toBe('unparseable');
    expect(await readFile(join(rootDir, ITEMS_REL), 'utf-8')).toBe('{not json');

    await writeFile(join(rootDir, ITEMS_REL), '{"items":[]}');
    expect((await migration.up({ rootDir })).reason).toBe('unexpected-shape');
  });
});

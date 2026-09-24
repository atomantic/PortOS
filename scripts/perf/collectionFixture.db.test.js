import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireDbOrSkip } from '../../server/lib/dbTestGate.js';
import { startCollectionFixture } from './collectionFixture.js';

const { Client } = createRequire(new URL('../../server/package.json', import.meta.url))('pg');
let client;
let clientDist;
let available;
const schemas = async () => (await client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'collection_audit_%' ORDER BY nspname")).rows.map(row => row.nspname);
const roots = async () => (await readdir(tmpdir())).filter(name => name.startsWith('portos-collection-audit-')).sort();

beforeAll(async () => {
  if (process.env.PGDATABASE !== 'portos_test') {
    available = requireDbOrSkip('collection fixture', false, 'requires portos_test');
    return;
  }
  client = new Client({ database: 'portos_test', host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'portos',
    password: process.env.PGPASSWORD || 'portos', options: '', connectionTimeoutMillis: 2000 });
  try { await client.connect(); available = true; } catch {
    available = requireDbOrSkip('collection fixture', false, 'test database unavailable');
  }
  if (available) {
    clientDist = await mkdtemp(join(tmpdir(), 'collection-client-test-'));
    await writeFile(join(clientDist, 'index.html'), '<!doctype html><title>Synthetic lifecycle client</title>');
  }
});
afterAll(async () => {
  await client?.end();
  if (clientDist) await rm(clientDist, { recursive: true, force: true });
});

describe('isolated fixture using real collection routes and storage', () => {
  it('pages PostgreSQL media and projected inbox data, then removes only its resources', async context => {
    if (!available) return context.skip();
    const beforeSchemas = await schemas();
    const beforeRoots = await roots();
    const fixture = await startCollectionFixture({ clientDist });
    const get = async path => {
      const response = await fetch(fixture.url + path);
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      expect((await get('/__fixture/ready')).cardinalities).toMatchObject({ images: 2400, videos: 1200, messages: 4000 });
      const page = await get('/api/image-gen/gallery?limit=7&offset=0&media=true&kind=all&summary=true&hidden=false');
      expect(page).toMatchObject({ total: 3240, hiddenTotal: 360, counts: { image: 2160, video: 1080, all: 3240 } });
      expect(page.items).toHaveLength(7);
      expect(new Set(page.items.map(item => item.kind))).toEqual(new Set(['image', 'video']));
      expect(page.items.every(item => !item.data.hidden)).toBe(true);
      const next = await get('/api/image-gen/gallery?limit=7&offset=7&media=true&kind=all&hidden=false');
      expect(next.items.map(item => item.data.filename).some(name => page.items.some(item => item.data.filename === name))).toBe(false);
      const inbox = await get('/api/messages/inbox?limit=11&offset=20&summary=true');
      expect(inbox.total).toBe(4000);
      expect(inbox.messages).toHaveLength(11);
      expect(inbox.messages[0]).not.toHaveProperty('bodyHtml');
      expect(inbox.messages[0].evaluation).not.toHaveProperty('reasoning');
      const summary = inbox.messages[0];
      const detail = await get('/api/messages/' + summary.accountId + '/' + summary.id);
      expect(detail.bodyText).toHaveLength(8192);
      expect((await fetch(fixture.url + '/api/messages/sync/' + summary.accountId, { method: 'POST' })).status).toBe(503);
      expect((await fetch(fixture.url + '/api/image-gen/generate', { method: 'POST' })).status).toBe(405);
      expect((await fetch(fixture.url + '/messages/inbox')).headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect((await schemas()).length).toBe(beforeSchemas.length + 1);
    } finally {
      await fixture.close();
      await fixture.close();
    }
    expect(await schemas()).toEqual(beforeSchemas);
    expect(await roots()).toEqual(beforeRoots);
    await expect(fetch(fixture.url + '/__fixture/ready')).rejects.toThrow();
  }, 120000);

  it('cleans fixture resources on SIGTERM', async context => {
    if (!available) return context.skip();
    const beforeSchemas = await schemas();
    const beforeRoots = await roots();
    const moduleUrl = new URL('./collectionFixture.js', import.meta.url).href;
    const source = 'import { startCollectionFixture } from ' + JSON.stringify(moduleUrl)
      + '; const f = await startCollectionFixture({ clientDist: ' + JSON.stringify(clientDist)
      + ' }); console.log(JSON.stringify({ url: f.url }));';
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    child.stderr.resume();
    try {
      await new Promise((resolveReady, rejectReady) => {
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('\n')) resolveReady();
        });
        child.once('error', rejectReady);
        child.once('exit', code => rejectReady(new Error('Fixture exited early: ' + code)));
      });
      child.kill('SIGTERM');
      expect((await exited)[0]).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
    }
    expect(await schemas()).toEqual(beforeSchemas);
    expect(await roots()).toEqual(beforeRoots);
  }, 120000);

  it('cleans the temporary root when database startup fails', async context => {
    if (!available) return context.skip();
    const before = await roots();
    await expect(startCollectionFixture({ clientDist, env: { PGDATABASE: 'portos_test', PGPORT: '1' } })).rejects.toThrow();
    expect(await roots()).toEqual(before);
  }, 120000);
});

/**
 * The server-owned namespaces have a hole that only shows up on an
 * EXTENSIONLESS path.
 *
 * The SPA fallback in `server/index.js` skips a request when its path carries a
 * file extension (`/\.\w+$/`), which worked only because every asset happened to
 * carry one. `/data/image-to-3d/<id>/model` — no extension, no matching mount —
 * fell through to the stamped index.html with a 200, so a binary loader parsed
 * HTML and died on a JSON syntax error naming a `<` token, nowhere near the
 * cause. A mistyped `/api/…` had the same hole, handing an API client HTML with
 * a success status. The terminators close both, and this pins every half: they
 * fire, the client's own `/data` page still reaches the SPA fallback, and real
 * assets are still served.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Re-roots every `PATHS` member under a temp tree, so the mounts resolve there
// instead of at the running install's `data/` — including `wrWorksDir()`, which
// derives from `PATHS.data`. This is why every `dir` in the table is a thunk:
// it has to read `PATHS` after this mock applies, not at import.
const tempRoot = createTempDataRoot('portos-asset-mounts-');
vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: tempRoot })
));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

// Dynamic, not a static import: the `vi.mock` factory above closes over
// `tempRoot`, and a static import would be hoisted above that binding.
const { ASSET_DIR_ROUTES, ASSET_MOUNTS, mountAssetRoutes } = await import('./assetMounts.js');

// Stand-in for the SPA fallback `server/index.js` installs after the asset
// mounts — same extension guard, so the test exercises the real interaction
// between the terminators and the fallback rather than a terminator alone.
const spaFallback = (req, res, next) => {
  if (req.path.match(/\.\w+$/) && !req.path.endsWith('.html')) return next();
  res.type('html').send('<!DOCTYPE html><html><body>PortOS</body></html>');
};

let app;

beforeAll(() => {
  // Real files under real mounts, so "the asset mounts still work" is proved by
  // bytes coming back rather than by the absence of a 404.
  mkdirSync(join(tempRoot, 'images'), { recursive: true });
  writeFileSync(join(tempRoot, 'images', 'probe.png'), 'PNGBYTES');
  const drafts = join(tempRoot, 'writers-room', 'works', 'wr-work-1');
  mkdirSync(join(drafts, 'drafts'), { recursive: true });
  writeFileSync(join(drafts, 'drafts', 'd1.md'), '# body');
  writeFileSync(join(drafts, 'manifest.json'), '{"private":true}');

  app = express();
  mountAssetRoutes(app);
  app.use(spaFallback);
});

describe('the server-owned namespace terminators', () => {
  it('404s an extensionless /data path instead of answering with the SPA index', async () => {
    const res = await request(app).get('/data/image-to-3d/abc123/model');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Not found', code: 'NOT_FOUND' });
    expect(res.text).not.toContain('<!DOCTYPE');
  });

  it('404s an extensioned /data path that no mount serves', async () => {
    const res = await request(app).get('/data/image-to-3d/abc123/model.glb');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  // Same hole, worse symptom: a client asking for JSON got HTML and a 200.
  it('404s a mistyped API path instead of answering with the SPA index', async () => {
    for (const path of ['/api/does-not-exist', '/sdapi/v1/nope']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('still hands the client its own /data page', async () => {
    for (const path of ['/data', '/data/']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain('PortOS');
    }
  });

  it('leaves a sibling route whose name merely starts with "data" alone', async () => {
    // `app.use('/data', …)` matches on segment boundaries. `/datadog` is the
    // probe that observes that — `/devtools/datadog` never reaches the
    // terminator under any implementation, so it would prove nothing.
    const res = await request(app).get('/datadog');
    expect(res.status).toBe(200);
    expect(res.text).toContain('PortOS');
  });

  // `spaPaths` entries are route PATTERNS, not literals — the drift guard tells
  // people to add a client route there when it fails, and the router convention
  // produces parameterized ones. A literal compare would 404 every concrete
  // path while the declaration sat in the list looking correct.
  it('lets a parameterized spaPaths entry through to the SPA', async () => {
    const patterned = express();
    mountAssetRoutes(patterned, [{ prefix: '/data', spaPaths: ['/data', '/data/:category'] }]);
    patterned.use(spaFallback);

    const page = await request(patterned).get('/data/images');
    expect(page.status).toBe(200);
    expect(page.text).toContain('PortOS');

    // ...and only one segment deep, exactly as the pattern says.
    const tooDeep = await request(patterned).get('/data/images/nested/thing');
    expect(tooDeep.status).toBe(404);
  });

  it('still serves an asset from a mount', async () => {
    const res = await request(app).get('/data/images/probe.png');
    expect(res.status).toBe(200);
    expect(res.text).toBe('PNGBYTES');
  });
});

describe('the writers-room draft-body gate', () => {
  it('serves a draft body but not the metadata beside it', async () => {
    const body = await request(app).get('/data/writers-room/works/wr-work-1/drafts/d1.md');
    expect(body.status).toBe(200);
    expect(body.text).toBe('# body');

    // The gate is what keeps the static root from also serving adjacent
    // work-metadata JSON to any client that knows a work id.
    const manifest = await request(app).get('/data/writers-room/works/wr-work-1/manifest.json');
    expect(manifest.status).toBe(404);
    expect(manifest.text).not.toContain('private');
  });
});

describe('ASSET_MOUNTS', () => {
  it('anchors every route under a namespace the terminators close', () => {
    // A mount added outside `/data/` would keep the pre-#4688 behaviour: an
    // extensionless path under it answered with the SPA index and a 200.
    expect(ASSET_MOUNTS.length).toBeGreaterThan(5);
    expect(ASSET_MOUNTS.filter(({ route }) => !route.startsWith('/data/'))).toEqual([]);
  });

  it('mounts every route it knows a directory for', () => {
    // The mount list is built by walking `ASSET_ROUTE_PREFIXES`, so a directory
    // added to `ASSET_DIRS` alone is never mounted and nothing else notices —
    // the asset just 404s. (The reverse fails loudly: a prefix with no dir
    // throws at boot.)
    expect([...ASSET_DIR_ROUTES].sort()).toEqual([...ASSET_MOUNTS.map((m) => m.route)].sort());
    expect(ASSET_MOUNTS.every(({ dir }) => typeof dir === 'function')).toBe(true);
  });
});

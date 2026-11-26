import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSocketEventInventory,
  getSocketEventInventory,
  scanSocketEventFile,
} from './socketEventInventory.js';

const write = (root, path, source) => {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, source, 'utf8');
};

const tempRoots = [];
const makeTempRoot = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Server-emitted events with no client reference today. Each is either an
// external consumer (a federated peer server, not the browser) or tracked debt:
// an unlistened emit is either dead and should be deleted, or a missing client
// feature. The guard below pins this list exactly so it can only shrink on
// purpose and a NEW unlistened emit fails the suite instead of landing silently.
const EXTERNAL_CONSUMER_EVENTS = [
  'cos:subscribe', // peerSocketRelay acts as the socket client toward a remote PortOS
  'peer:sync:available', // consumed by peer servers through peerSyncEventBus
  'peer:sync:event',
  'peer:sync:subscribe',
];
const TRACKED_UNLISTENED_EVENTS = [
  'calendar:sync:failed', 'calendar:sync:started',
  'health:import:progress', // Existing clinical progress frames surfaced by the migration (#19473).
  'health:xml:complete',
  'messages:sync:auth-required', 'messages:sync:failed', 'messages:sync:started',
  'provider:error',
];
const isAckOrTemplate = (event) => /:(?:un)?subscribed$/.test(event) || /[{}]/.test(event);

describe('Socket.IO event inventory', () => {
  it('flags a server emit that no client source names, and accepts constant-array listeners', async () => {
    const root = makeTempRoot('portos-socket-parity-');
    write(root, 'server/services/socket.js', `io.emit('demo:orphan', {}); io.emit('demo:listened', {}); io.emit('demo:array', {});`);
    write(root, 'client/src/demo.jsx', `socket.on('demo:listened', h); const EVENTS = ['demo:array']; socket.on('demo:clientonly', h);`);
    const { events } = await buildSocketEventInventory({ repoRoot: root });
    const byName = Object.fromEntries(events.map((event) => [event.event, event]));
    expect(byName['demo:orphan']).toMatchObject({ serverEmitted: true, clientReferenced: false });
    expect(byName['demo:listened']).toMatchObject({ serverEmitted: true, clientReferenced: true });
    expect(byName['demo:array']).toMatchObject({ serverEmitted: true, clientReferenced: true });
    expect(byName['demo:clientonly']).toMatchObject({ serverEmitted: false, clientReferenced: true });
  });

  it('every server-to-client event emitted by server/ has a client listener or an explicit exemption', async () => {
    const { events } = await buildSocketEventInventory();
    const unlistened = events
      .filter((event) => event.serverEmitted && !event.clientReferenced && !isAckOrTemplate(event.event))
      .map((event) => event.event)
      .sort();
    expect(unlistened).toEqual([...EXTERNAL_CONSUMER_EVENTS, ...TRACKED_UNLISTENED_EVENTS].sort());
  });

  it('detects req.app.get(io), getIo(), alias and room-scoped emits', async () => {
    const root = makeTempRoot('portos-socket-shapes-');
    write(root, 'server/routes/shapes.js', `
      req.app.get('io')?.emit('shape:route', {});
      req.app.get("io").emit('shape:route-strict', {});
      getIo()?.emit('shape:getio', {});
      boundIo?.emit('shape:bound', {});
      providersIo?.emit('shape:providers', {});
      ioRef?.emit('shape:ref', {});
      io.of('/ns').to(\`session:\${id}\`).emit('shape:room', {});
      io.to(roomFor(id)).except(sid).emit('shape:except', {});
      ns.to(room).emit('shape:ns', {});
      emitToOperatorsOn(io, 'shape:operator-io', {});
      emitToOperators('shape:operator-global', {});
      emitToOperatorsOn(req.app.get('io'), 'shape:operator-route', {});
      emitToOperatorsOn(getIo()?.except(room), 'shape:operator-except', {});
    `);
    write(root, 'client/src/empty.js', 'export default {};');
    const { events } = await buildSocketEventInventory({ repoRoot: root });
    expect(events.filter((e) => e.serverEmitted).map((e) => e.event).sort()).toEqual([
      'shape:bound', 'shape:except', 'shape:getio', 'shape:providers', 'shape:ref',
      'shape:room', 'shape:route', 'shape:route-strict', 'shape:ns',
      'shape:operator-io', 'shape:operator-global', 'shape:operator-route', 'shape:operator-except',
    ].sort());
  });

  it('merges client/server declarations and normalizes bounded template events', async () => {
    const root = makeTempRoot('portos-socket-inventory-');
    write(root, 'server/services/socket.js', `
      socket.on('demo:start', handler);
      io.emit('demo:done', data);
      io?.emit('demo:optional', data);
      socket.emit(\`demo:step:\${kind}\`, data);
    `);
    write(root, 'server/sockets/empty.js', 'export default {};');
    write(root, 'client/src/demo.jsx', `
      socket.emit('demo:start', {});
      socket.on('demo:done', handler);
    `);
    const inventory = await buildSocketEventInventory({ repoRoot: root });
    expect(inventory.events.find((event) => event.event === 'demo:start').directions).toEqual(['client-to-server']);
    expect(inventory.events.find((event) => event.event === 'demo:done').directions).toEqual(['server-to-client']);
    expect(inventory.events.map((event) => event.event)).toContain('demo:optional');
    expect(inventory.events.map((event) => event.event)).toContain('demo:step:{kind}');
    expect(inventory.events.every((event) => !('sources' in event) && !('line' in event))).toBe(true);
  });

  it('classifies client lifecycle listeners and excludes the isolated runner tree', async () => {
    const root = makeTempRoot('portos-socket-file-');
    write(root, 'server/sockets/empty.js', 'export default {};');
    write(root, 'server/cos-runner/isolated.js', `socket.emit('runner:internal');`);
    write(root, 'client/src/socket.js', `socket.on('connect', handler); socket.emit('shell:start', {});`);
    expect(await scanSocketEventFile(join(root, 'client/src/socket.js'), root)).toEqual([
      { event: 'connect', direction: 'server-to-client' },
      { event: 'shell:start', direction: 'client-to-server' },
    ]);
    expect((await buildSocketEventInventory({ repoRoot: root })).events.map((event) => event.event))
      .not.toContain('runner:internal');
  });

  it('derives a unique current inventory with representative lifecycle events', async () => {
    const inventory = await buildSocketEventInventory();
    expect(inventory.stats.events).toBeGreaterThan(100);
    expect(new Set(inventory.events.map((event) => event.event)).size).toBe(inventory.events.length);
    const names = new Set(inventory.events.map((event) => event.event));
    for (const event of [
      'cos:mind:event',
      'cos:subscribe',
      'voice:text',
      'shell:start',
      'image-gen:completed',
      'error:occurred',
      'backup:failed',
      'calendar:sync:started',
      'digital-twin:test-progress',
      'sharing:inbox-updated',
    ]) {
      expect(names.has(event), event).toBe(true);
    }
  });

  it('shares the first-use scan across the server process', async () => {
    const first = getSocketEventInventory();
    const second = getSocketEventInventory();
    expect(second).toBe(first);
    expect((await first).stats.events).toBeGreaterThan(100);
  });
});

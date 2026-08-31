import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

describe('Socket.IO event inventory', () => {
  it('merges client/server declarations and normalizes bounded template events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-socket-inventory-'));
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
    const root = mkdtempSync(join(tmpdir(), 'portos-socket-file-'));
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

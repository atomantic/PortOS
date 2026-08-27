import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MANIFEST_RELATIVE_PATH,
  REGENERATE_COMMAND,
  REPO_ROOT,
  buildSocketEventCatalog,
  readSocketEventCatalog,
  scanSocketEventFile,
  serializeSocketEventCatalog,
} from './generate-socket-event-catalog.js';

const write = (root, path, source) => {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, source, 'utf8');
};

describe('Socket.IO event catalog scanner', () => {
  it('merges client/server evidence and normalizes bounded template events', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-socket-catalog-'));
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
    const catalog = buildSocketEventCatalog({ repoRoot: root });
    expect(catalog.events.find((event) => event.event === 'demo:start').directions).toEqual(['client-to-server']);
    expect(catalog.events.find((event) => event.event === 'demo:done').sources).toHaveLength(2);
    expect(catalog.events.map((event) => event.event)).toContain('demo:optional');
    expect(catalog.events.map((event) => event.event)).toContain('demo:step:{kind}');
  });

  it('does not classify client lifecycle listeners as outbound calls', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-socket-file-'));
    write(root, 'client/src/socket.js', `socket.on('connect', handler); socket.emit('shell:start', {});`);
    expect(scanSocketEventFile(join(root, 'client/src/socket.js'), root)).toEqual([
      expect.objectContaining({ event: 'connect', direction: 'server-to-client' }),
      expect.objectContaining({ event: 'shell:start', direction: 'client-to-server' }),
    ]);
  });
});

describe('generated Socket.IO event catalog', () => {
  it('matches a fresh source scan', () => {
    const stale = `${MANIFEST_RELATIVE_PATH} is stale — run \`${REGENERATE_COMMAND}\` and commit the result.`;
    const fresh = buildSocketEventCatalog();
    expect(fresh, stale).toEqual(readSocketEventCatalog());
    expect(readFileSync(join(REPO_ROOT, MANIFEST_RELATIVE_PATH), 'utf8'), stale)
      .toBe(serializeSocketEventCatalog(fresh));
  });

  it('is a unique all-source inventory with representative lifecycle events', () => {
    const catalog = readSocketEventCatalog();
    expect(catalog.stats.events).toBeGreaterThan(100);
    expect(new Set(catalog.events.map((event) => event.event)).size).toBe(catalog.events.length);
    const names = new Set(catalog.events.map((event) => event.event));
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
    expect(catalog.events.flatMap((event) => event.sources).some((source) => source.source.startsWith('server/cos-runner/'))).toBe(false);
  });
});

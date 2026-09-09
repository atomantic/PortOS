import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// `pm2 logs` writes app output to stdout and its own diagnostics to stderr, on
// two independent EventEmitters of the SAME child. The handler reassembles
// lines from chunk boundaries, so the contract this suite pins is that neither
// stream can ever see, splice onto, or steal the other's partial tail — and
// that a final line with no trailing newline (what a crashing process leaves)
// still reaches the client before `logs:close`.

vi.mock('../services/pm2.js', () => ({
  buildEnv: vi.fn(() => ({})),
  spawnPm2: vi.fn(),
}));
vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(async () => null),
  resolvePm2HomeForProcess: vi.fn(async () => null),
}));

import { spawnPm2 } from '../services/pm2.js';
import { registerLogHandlers, cleanupSocketStreams } from './logs.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

const subscribe = async (processName = 'example-app') => {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    id: 'socket-test',
    disconnected: false,
    on: (event, fn) => handlers.set(event, fn),
    emit: (event, payload) => emitted.push({ event, payload }),
  };
  const child = makeChild();
  spawnPm2.mockReturnValue(child);
  registerLogHandlers(socket, { emit: () => {} });
  await handlers.get('logs:subscribe')({ processName, lines: 100 });
  return { socket, child, emitted, processName };
};

const linesOf = (emitted) => emitted
  .filter((e) => e.event === 'logs:line')
  .map((e) => ({ line: e.payload.line, type: e.payload.type }));

beforeEach(() => {
  vi.clearAllMocks();
  cleanupSocketStreams('socket-test');
});

describe('logs:subscribe line reassembly', () => {
  it('does not splice a stderr chunk onto a partial stdout line', async () => {
    const { child, emitted } = await subscribe();

    // stdout chunk ends mid-line — its tail must stay private to stdout.
    child.stdout.emit('data', Buffer.from('GET /api/app'));
    child.stderr.emit('data', Buffer.from('[PM2] Log rotation\n'));
    child.stdout.emit('data', Buffer.from(' 200 OK\n'));

    expect(linesOf(emitted)).toEqual([
      { line: '[PM2] Log rotation', type: 'stderr' },
      { line: 'GET /api/app 200 OK', type: 'stdout' },
    ]);
  });

  it('emits a trailing line with no newline before logs:close', async () => {
    const { child, emitted } = await subscribe();

    child.stdout.emit('data', Buffer.from('fatal: crashed'));
    child.emit('close', 1);

    const events = emitted.filter((e) => e.event === 'logs:line' || e.event === 'logs:close');
    expect(events).toEqual([
      { event: 'logs:line', payload: expect.objectContaining({ line: 'fatal: crashed', type: 'stdout' }) },
      { event: 'logs:close', payload: { code: 1, processName: 'example-app' } },
    ]);
  });

  it('flushes each stream\'s own tail on close', async () => {
    const { child, emitted } = await subscribe();

    child.stdout.emit('data', Buffer.from('out tail'));
    child.stderr.emit('data', Buffer.from('err tail'));
    child.emit('close', 0);

    expect(linesOf(emitted)).toEqual([
      { line: 'out tail', type: 'stdout' },
      { line: 'err tail', type: 'stderr' },
    ]);
  });
});

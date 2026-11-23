import { describe, expect, it } from 'vitest';
import { parseCommandArgs } from './commandSecurity.js';
import {
  EIDOVERSE_LOOPBACK_PRELOAD as PRELOAD,
  eidoverseStartCommand,
  hasLoopbackPreload,
  withLoopbackPreload,
} from './eidoverseStartCommand.js';

const TAIL = ['--env-file=.env.portos', 'server/server.ts'];

describe('Eidoverse start command', () => {
  it.each(['bun', '/opt/example tools/bun', "/opt/o'example/bun", 'C:\\Program Files\\bun\\bin\\bun.exe'])(
    'loads the preload from %s and survives the PM2 argument parser',
    (bun) => {
      expect(parseCommandArgs(eidoverseStartCommand(bun))).toEqual([bun, '--preload', PRELOAD, ...TAIL]);
    },
  );

  it('upgrades a stored command and keeps the operator bun path and flags', () => {
    const upgraded = withLoopbackPreload('"/opt/example tools/bun" --smol --env-file=.env.portos server/server.ts');
    expect(parseCommandArgs(upgraded)).toEqual(['/opt/example tools/bun', '--preload', PRELOAD, '--smol', ...TAIL]);
    expect(withLoopbackPreload(upgraded)).toBe(upgraded);
  });

  it.each([
    'bun --preload /old/server/lib/eidoverseLoopbackPreload.js --env-file=.env.portos server/server.ts',
    'bun --preload=/old/server/lib/eidoverseLoopbackPreload.js --env-file=.env.portos server/server.ts',
  ])('replaces a preload from an older install root: %s', (command) => {
    expect(withLoopbackPreload(command)).toBe(eidoverseStartCommand('bun'));
  });

  it.each([undefined, '', 'npm run dev', './start.sh'])('cannot place the preload in %s', (command) => {
    expect(withLoopbackPreload(command)).toBeNull();
  });

  it('recognizes only the current preload in PM2 args', () => {
    expect(hasLoopbackPreload(['--preload', PRELOAD, ...TAIL])).toBe(true);
    expect(hasLoopbackPreload(['--preload', '/old/server/lib/eidoverseLoopbackPreload.js', ...TAIL])).toBe(false);
    expect(hasLoopbackPreload(TAIL)).toBe(false);
    expect(hasLoopbackPreload(null)).toBe(false);
  });
});

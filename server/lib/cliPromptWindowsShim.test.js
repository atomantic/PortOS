import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareCliPrompt } from './cliProviderArgs.js';
import { prepareCliSpawn } from './bufferedSpawn.js';

// agy, kimi, openchamber and pi take the prompt on argv. Installed through npm
// on Windows they are .cmd shims, and cmd.exe would parse tracker or model
// text inside that prompt as commands (#12346). Composed exactly as the spawn
// sites compose it: vendor prompt delivery, then shim resolution.
const shimFor = (bin) => [
  '@ECHO off',
  'SETLOCAL',
  'SET dp0=%~dp0',
  `"%dp0%\\node.exe"  "%dp0%\\node_modules\\${bin}\\cli.js" %*`,
  '',
].join('\r\n');
const HOSTILE_PROMPT = 'Fix the issue titled " & calc & " today';

describe('argv-prompt vendors on a Windows npm shim (#12346)', () => {
  let binDir;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'win-prompt-shim-'));
    await writeFile(join(binDir, 'node.exe'), '');
  });

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  it.each(['agy', 'kimi', 'openchamber', 'pi'])('%s never hands the prompt to cmd.exe', async (bin) => {
    const script = join(binDir, 'node_modules', bin, 'cli.js');
    await mkdir(join(binDir, 'node_modules', bin), { recursive: true });
    await writeFile(script, '');
    await writeFile(join(binDir, `${bin}.cmd`), shimFor(bin));

    const { args } = prepareCliPrompt(bin, [], HOSTILE_PROMPT, { cwd: binDir });
    expect(args.some((arg) => arg.includes(HOSTILE_PROMPT))).toBe(true);
    const spawned = prepareCliSpawn(bin, args, { PATH: binDir }, true);

    expect(spawned).toEqual({ command: join(binDir, 'node.exe'), args: [script, ...args] });
  });
});

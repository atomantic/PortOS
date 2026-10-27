import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { windowsPowerShell51Path } from '../lib/processEnv.js';
import { isPathInsideDir } from '../lib/pathSafety.js';
import { quoteForShell } from '../lib/shellCd.js';
import { createShellSession, getSessionProcess, killSession, submitToSession } from './shell.js';

// Real ConPTY/shell contracts with a tiny local CLI stand-in. No provider,
// model, network request, repository copy or application data is involved.
describe.skipIf(process.platform !== 'win32')('native Windows shell and filesystem contracts', () => {
  it('uses native case/separator semantics without accepting a sibling-prefix path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portos-native-path-'));
    try {
      const child = join(root, 'workspace [literal] & name');
      await mkdir(child);
      expect((await stat(child.toUpperCase())).isDirectory()).toBe(true);
      expect(isPathInsideDir(root.toUpperCase(), child.toLowerCase())).toBe(true);
      expect(isPathInsideDir(root, join(`${root}-sibling`, 'file'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['cmd', 'powershell'])('launches a CLI in %s and submits an exact prompt through ConPTY', async flavor => {
    const root = await mkdtemp(join(tmpdir(), 'portos-native-tui-'));
    let sessionId, terminal, exited;
    let output = '';
    try {
      const workspace = join(root, 'workspace [literal] & name');
      await mkdir(workspace);
      const helper = join(workspace, 'echo.cjs');
      const reply = join(workspace, 'reply.json');
      await writeFile(helper, [
        "const fs = require('node:fs');",
        "const readline = require('node:readline');",
        "const input = readline.createInterface({ input: process.stdin, terminal: false });",
        "process.stdout.write('PORTOS_NATIVE_READY\\n');",
        "input.once('line', prompt => {",
        "  fs.writeFileSync(process.env.PORTOS_NATIVE_REPLY, JSON.stringify({ prompt, cwd: process.cwd(), env: process.env.PORTOS_NATIVE_ENV }));",
        '  input.close();',
        '  process.exit(0);',
        '});',
      ].join('\n'));
      const shell = flavor === 'cmd' ? (process.env.ComSpec || 'cmd.exe') : windowsPowerShell51Path();
      sessionId = createShellSession(null, { shell, cwd: workspace,
        env: { PORTOS_NATIVE_REPLY: reply, PORTOS_NATIVE_ENV: 'exact-child-env' },
        onData: chunk => { output += chunk; },
      });
      expect(sessionId).toBeTruthy();
      terminal = getSessionProcess(sessionId);
      terminal.onExit(result => { exited = result; });
      // Wait for the shell's actual prompt, then use the public Enter path.
      await vi.waitFor(() => expect(output.includes('>')).toBe(true), { timeout: 10000, interval: 20 });
      const command = `${quoteForShell(process.execPath, flavor, 'command')} ${quoteForShell(helper, flavor)}`;
      expect(submitToSession(sessionId, command)).toBe(true);
      await vi.waitFor(() => expect(output.includes('PORTOS_NATIVE_READY')).toBe(true), { timeout: 10000, interval: 20 });
      const prompt = 'Exact "prompt" & %PATH% | [literal] ^ text';
      expect(submitToSession(sessionId, prompt)).toBe(true);
      let received;
      await vi.waitFor(async () => { received = JSON.parse(await readFile(reply, 'utf8')); }, { timeout: 5000, interval: 20 });
      expect(received.prompt).toBe(prompt);
      expect(received.env).toBe('exact-child-env');
      expect((await realpath(received.cwd)).toLowerCase() === (await realpath(workspace)).toLowerCase()).toBe(true);
      expect(submitToSession(sessionId, 'exit')).toBe(true);
      await vi.waitFor(() => expect(exited?.exitCode).toBe(0), { timeout: 5000, interval: 20 });
    } finally {
      if (terminal && !exited) killSession(sessionId);
      // A kill request is not settlement. Keep the fixture if ConPTY has not
      // actually exited; its failing test/leak evidence must remain visible.
      if (terminal) await vi.waitFor(() => expect(exited).toBeDefined(), { timeout: 5000, interval: 20 });
      await rm(root, { recursive: true, force: true });
    }
  });
});

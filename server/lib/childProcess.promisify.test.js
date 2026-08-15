import { describe, it, expect } from 'vitest';
import { promisify } from 'node:util';
import { exec, execFile, execFileSync, spawn } from './childProcess.js';

// Unmocked, against the real child_process, because the thing under test is the
// `promisify.custom` delegation — which only exists on node's own exec/execFile.
// A mocked child_process has no custom hook, so a mocked test would prove
// nothing about the shape real callers get back.
//
// `process.execPath -e` is the one command guaranteed present on every platform
// CI runs on.
const NODE = process.execPath;

describe('childProcess promisify fidelity', () => {
  it('resolves promisify(execFile) to { stdout, stderr }', async () => {
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync(NODE, ['-e', 'process.stdout.write("hi")']);
    // The regression this guards: generic callback wrapping resolves to the
    // bare stdout string, so `const { stdout } = await …` yields undefined.
    expect(result).toEqual({ stdout: 'hi', stderr: '' });
  });

  it('resolves promisify(exec) to { stdout, stderr }', async () => {
    const execAsync = promisify(exec);
    const result = await execAsync(`"${NODE}" -e "process.stdout.write('hi')"`);
    expect(result.stdout).toBe('hi');
    expect(result.stderr).toBe('');
  });

  it('forwards options through the promisified path', async () => {
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(NODE, ['-e', 'process.stdout.write(process.env.PORTOS_PROBE)'], {
      env: { ...process.env, PORTOS_PROBE: 'forwarded' },
    });
    expect(stdout).toBe('forwarded');
  });

  it('rejects on a non-zero exit, preserving node error semantics', async () => {
    const execFileAsync = promisify(execFile);
    await expect(execFileAsync(NODE, ['-e', 'process.exit(3)'])).rejects.toMatchObject({ code: 3 });
  });
});

describe('childProcess real execution', () => {
  it('runs execFileSync and returns output', () => {
    const out = execFileSync(NODE, ['-e', 'process.stdout.write("sync")'], { encoding: 'utf8' });
    expect(out).toBe('sync');
  });

  it('runs spawn and streams stdout', async () => {
    const child = spawn(NODE, ['-e', 'process.stdout.write("streamed")']);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('streamed');
  });
});

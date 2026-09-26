import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

// A fake child speaks the JSON-RPC handshake back, so this pins the PROTOCOL
// (initialize → initialized + model/list, hidden filtering, error/timeout/exit
// handling) rather than whether `codex` happens to be installed.
vi.mock('child_process', () => ({ spawn: vi.fn() }));
const { spawn } = await import('child_process');
const { probeCodexModelsViaAppServer } = await import('./codexModelListProbe.js');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('probeCodexModelsViaAppServer', () => {
  it('merges a provider record\'s envVars over process.env for the spawned child', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    probeCodexModelsViaAppServer('codex', ['app-server'], { envVars: { OPENAI_API_KEY: 'example-key' } });

    const [, , spawnOptions] = spawn.mock.calls[0];
    expect(spawnOptions.env).toMatchObject({ ...process.env, OPENAI_API_KEY: 'example-key' });
  });

  it('runs under plain process.env when there is no provider record (a bare harness probe)', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    probeCodexModelsViaAppServer('codex', ['app-server'], null);

    const [, , spawnOptions] = spawn.mock.calls[0];
    expect(spawnOptions.env).toEqual(process.env);
  });

  it('drives initialize → initialized + model/list, filters hidden entries, and de-dupes', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = probeCodexModelsViaAppServer('codex', ['app-server'], null);
    // Handshake starts with `initialize`.
    expect(JSON.parse(child.stdin.write.mock.calls[0][0])).toMatchObject({ id: 1, method: 'initialize' });

    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    // `initialized` (a notification) then the `model/list` request follow.
    expect(JSON.parse(child.stdin.write.mock.calls[1][0])).toMatchObject({ method: 'initialized' });
    expect(JSON.parse(child.stdin.write.mock.calls[2][0])).toMatchObject({ id: 2, method: 'model/list' });

    child.stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-hidden', hidden: true }, 'gpt-6-sol', 'gpt-6-sol'] },
    })}\n`);

    await expect(promise).resolves.toEqual(['gpt-6-astra', 'gpt-6-sol']);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects with the RPC error message when model/list answers one', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = probeCodexModelsViaAppServer('codex', ['app-server'], null);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { message: 'not signed in' } })}\n`);

    await expect(promise).rejects.toThrow(/not signed in/);
  });

  it('rejects when the catalog answers with no usable ids', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = probeCodexModelsViaAppServer('codex', ['app-server'], null);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { data: [] } })}\n`);

    await expect(promise).rejects.toThrow(/returned no model ids/);
  });

  it('rejects when the process exits before answering', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = probeCodexModelsViaAppServer('codex', ['app-server'], null);
    child.emit('exit', 1, null);

    await expect(promise).rejects.toThrow(/exited prematurely with code 1/);
  });

  it('rejects when the child cannot be spawned at all', async () => {
    spawn.mockImplementation(() => { throw new Error('ENOENT'); });

    await expect(probeCodexModelsViaAppServer('codex', ['app-server'], null)).rejects.toThrow(/failed to spawn/);
  });

  it('settles only once even if exit and a late message both arrive', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = probeCodexModelsViaAppServer('codex', ['app-server'], null);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { data: ['gpt-6-astra'] } })}\n`);
    child.emit('exit', 0, null); // must not flip an already-settled resolution to a rejection

    await expect(promise).resolves.toEqual(['gpt-6-astra']);
  });
});

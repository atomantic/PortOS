import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSecurityScanManager } from './securityScan.js';

const grant = { model: 'example-model', effort: 'medium', auth: 'chatgpt', maxCostUsd: 2, timeLimitSeconds: 180 };
let root;
const outerAgents = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scanner-runtime-test-')); await mkdir(join(root, 'repo')); });
afterEach(async () => { for (const agent of outerAgents.splice(0)) clearTimeout(agent.killTimer); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

function setup({ finish, ...overrides } = {}) {
  let child;
  let onSpawn;
  const spawned = new Promise(resolve => { onSpawn = resolve; });
  const agent = { workspacePath: join(root, 'repo'), process: { kill: vi.fn() } };
  outerAgents.push(agent);
  const evidence = [];
  const spawnProcess = vi.fn((command, args, options) => {
    child = Object.assign(new EventEmitter(), { pid: 99999999, stdout: new PassThrough(), stderr: new PassThrough() });
    child.send = ({ command: scannerCommand, args: scannerArgs }, done) => {
      onSpawn({ child, command: scannerCommand, args: scannerArgs, options });
      done();
      if (finish) setImmediate(() => finish(child, scannerArgs));
    };
    return child;
  });
  const kill = vi.fn((_child, signal) => {
    if (_child === agent.process) agent.process.kill(signal);
    else setImmediate(() => child.emit('close', null, signal));
  });
  const manager = createSecurityScanManager({ agentsDir: join(root, 'agents'), getAgent: () => agent,
    emitEvidence: async (_id, value) => { evidence.push(value); },
    resolveCli: async () => ({ command: 'installed-scanner', args: [] }), spawnProcess, kill,
    cleanupGroup: async () => true, tempRoot: root,
    environment: { PATH: '/example/bin', HOME: root, OPENAI_API_KEY: 'example-not-a-key', PORTOS_API_TOKEN: 'example-not-a-token' },
    ...overrides });
  return { manager, agent, spawnProcess, kill, spawned, evidence };
}

const input = { prompt: 'Report-only source audit of the selected boundary.', paths: ['.'], knowledgeBase: [] };

describe.skipIf(process.platform === 'win32')('runner-owned scanner lifecycle', () => {
  it('pins the launch grant, strips API credentials and records successful evidence without an agent sentinel', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    const { child, args, options } = await h.spawned;
    expect(args).toContain('--auth');
    expect(args.slice(args.indexOf('--auth'), args.indexOf('--auth') + 2)).toEqual(['--auth', 'chatgpt']);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4)).toEqual(['--model', 'example-model', '--effort', 'medium']);
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options.env).not.toHaveProperty('PORTOS_API_TOKEN');
    expect(options.stdio[0]).toBe('ignore');
    const output = args[args.indexOf('--output-dir') + 1];
    await writeFile(join(output, 'findings.json'), '[]');
    await writeFile(join(output, 'coverage.json'), '{}');
    child.stdout.write('short-context budget baseline: $0.25 of $2.00 limit\n');
    child.emit('close', 0, null);
    const result = await run;
    expect(result.evidence).toMatchObject({ source: 'runner', status: 'completed', model: 'example-model', effort: 'medium',
      maxCostUsd: 2, timeLimitSeconds: 180, estimatedCostUsd: 0.25, exitCode: 0, artifacts: { findings: true, coverage: true } });
    expect(JSON.parse(await readFile(join(root, 'agents/agent-example/security-scan.json'), 'utf8'))).toEqual(result.evidence);
    expect(h.evidence.map(e => e.status)).toEqual(['not-run', 'running', 'completed']);
  });

  it('rejects request overrides and shares a single attempt across duplicate or lost-response requests', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    expect(() => h.manager.start('agent-example', { ...input, model: 'more-expensive-model' })).toThrow();
    const first = h.manager.start('agent-example', input);
    const replay = h.manager.start('agent-example', input);
    expect(first).toBe(replay);
    const { child } = await h.spawned;
    child.emit('close', 0, null);
    await first;
    expect(await h.manager.start('agent-example', input)).toEqual(await first);
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('latches a structured refusal, ignores exit zero and stops the outer request without retry', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    const { child } = await h.spawned;
    child.stderr.write('{"type":"turn.failed","error":{"codex_error_info":"cyber_');
    child.stderr.write('policy"}}\n');
    child.emit('close', 0, null);
    expect((await run).evidence.status).toBe('refused');
    expect(h.agent.process.kill).toHaveBeenCalledOnce();
    await h.manager.start('agent-example', input);
    expect(h.spawnProcess).toHaveBeenCalledOnce();
  });

  it('preserves interruption and artifact absence when the outer agent exits without completion', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    await h.spawned;
    const stopped = await h.manager.stop('agent-example');
    await run;
    expect(stopped).toMatchObject({ status: 'interrupted', exitCode: 143, cleanup: 'confirmed', artifacts: { findings: false, coverage: false } });
    expect(h.kill).toHaveBeenCalledWith(expect.anything(), 'SIGTERM', { processGroup: true });
  });

  it('keeps a buffered refusal terminal when cancellation has already started', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    const { child } = await h.spawned;
    const stopped = h.manager.stop('agent-example');
    child.stderr.write('{"type":"turn.failed","error":{"codex_error_info":"cyber_policy"}}\n');
    child.emit('close', 0, null);
    expect((await run).evidence.status).toBe('refused');
    expect((await stopped).status).toBe('refused');
    expect(h.kill).toHaveBeenCalledWith(h.agent.process, 'SIGTERM');
    await h.manager.start('agent-example', input);
    expect(h.spawnProcess).toHaveBeenCalledOnce();
  });

  it('lets cancellation during installation discovery prevent any child launch', async () => {
    let release;
    const h = setup({ resolveCli: () => new Promise(resolve => { release = resolve; }) });
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    const stopped = h.manager.stop('agent-example');
    release({ command: 'installed-scanner', args: [] });
    await Promise.all([run, stopped]);
    expect(h.spawnProcess).not.toHaveBeenCalled();
    expect((await h.manager.read('agent-example')).status).toBe('interrupted');
  });

  it('reports missing installation without npx, scanner defaults or fallback', async () => {
    const h = setup({ resolveCli: async () => null });
    await h.manager.register('agent-example', grant);
    expect((await h.manager.start('agent-example', input)).evidence.status).toBe('unavailable');
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });

  it('recovers a missing completion from durable evidence without relaunching or trusting a bare PID', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    await h.spawned;
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, 'agents/agent-example/security-scan-process.json'), 'utf8'))).toHaveProperty('marker'));
    const cleanupGroup = vi.fn(async () => false);
    const recovered = setup({ cleanupGroup });
    expect((await recovered.manager.stop('agent-example'))).toMatchObject({ status: 'interrupted', exitCode: null, cleanup: 'unconfirmed' });
    expect(recovered.spawnProcess).not.toHaveBeenCalled();
    await expect(recovered.manager.register('agent-example', grant)).rejects.toThrow('already exists');
    await h.manager.stop('agent-example');
    await run;
  });
  it('bounds a stuck child with the existing deadline and records unconfirmed cleanup without claiming success', async () => {
    const h = setup({ kill: vi.fn(), cleanupGroup: async () => false });
    await h.manager.register('agent-example', grant);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = h.manager.start('agent-example', input);
    await h.spawned;
    await vi.advanceTimersByTimeAsync(185000);
    expect((await run).evidence).toMatchObject({ status: 'time-limit', exitCode: null, cleanup: 'unconfirmed' });
  });

  it('does not treat quoted policy findings as a provider refusal', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    const { child } = await h.spawned;
    child.stdout.write(JSON.stringify({ findings: [{ title: 'cyber_policy', description: 'A quoted policy field in source code.' }] }) + '\n');
    child.emit('close', 0, null);
    expect((await run).evidence.status).toBe('completed');
    expect(h.agent.process.kill).not.toHaveBeenCalled();
  });

  it('never launches with missing resolved effort or paths outside the workspace', async () => {
    const h = setup();
    await h.manager.register('agent-example', { ...grant, effort: null });
    expect((await h.manager.start('agent-example', input)).evidence.status).toBe('unavailable');
    await h.manager.register('agent-other', grant);
    expect((await h.manager.start('agent-other', { ...input, paths: ['..'] })).evidence.status).toBe('unavailable');
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });

  it('still stops a refused outer request when publishing the final receipt fails', async () => {
    const h = setup({ emitEvidence: async (_id, value) => { if (value.status === 'refused') throw new Error('synthetic persistence outage'); } });
    await h.manager.register('agent-example', grant);
    const run = h.manager.start('agent-example', input);
    const { child } = await h.spawned;
    child.stderr.write('{"type":"turn.failed","error":{"codex_error_info":"cyber_policy"}}\n');
    await expect(run).rejects.toThrow('synthetic persistence outage');
    expect(h.agent.process.kill).toHaveBeenCalledOnce();
  });

  it('a refusal in final stderr wins over exit zero and forces an outer process that ignores TERM', async () => {
    const h = setup();
    await h.manager.register('agent-example', grant);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = h.manager.start('agent-example', input);
    const { child } = await h.spawned;
    child.emit('exit', 0, null);
    child.stderr.write('{"type":"turn.failed","error":{"codex_error_info":"cyber_policy"}}\n');
    child.emit('close', 0, null);
    expect((await run).evidence.status).toBe('refused');
    expect(h.agent.process.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.agent.process.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('boot recovery leaves a newly launched TUI grant usable while settling a prior runner receipt', async () => {
    const h = setup({ getAgent: id => id === 'agent-new' ? { workspacePath: join(root, 'repo') } : null });
    await h.manager.register('agent-new', grant);
    await h.manager.recover('agent-new');
    await mkdir(join(root, 'agents/agent-old'), { recursive: true });
    await writeFile(join(root, 'agents/agent-old/security-scan.json'), JSON.stringify({ ...(await h.manager.read('agent-new')), status: 'running' }));
    expect((await h.manager.recover('agent-old')).status).toBe('interrupted');
    const run = h.manager.start('agent-new', input);
    const { child } = await h.spawned;
    child.emit('close', 0, null);
    expect((await run).evidence.status).toBe('completed');
  });

});

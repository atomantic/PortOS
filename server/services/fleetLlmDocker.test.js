import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pinPlatform } from '../lib/testHelper.js';
const state = vi.hoisted(() => ({ requests: [], ready: [], settings: null }));
vi.mock('../lib/commandExists.js', () => ({ commandOutput: vi.fn(async (_cmd, args) => args.includes('docker') ? state.ready.shift() : '') }));
vi.mock('node:http', () => ({ default: { request: (options, callback) => {
  const req = new EventEmitter();
  req.destroy = () => {};
  req.end = (body) => {
    state.requests.push({ path: options.path, body: body ? JSON.parse(body) : undefined });
    const res = new EventEmitter(); res.statusCode = 200;
    const data = options.path === '/app/settings' && !body ? state.settings : options.path === '/error' ? { actions: ['Restart the WSL integration'] } : null;
    callback(res);
    queueMicrotask(() => { res.emit('data', JSON.stringify(data)); res.emit('end'); });
  };
  return req;
} } }));
import { ensureFleetDockerIntegration } from './fleetLlmDocker.js';
let restore;
beforeEach(() => { restore = pinPlatform('win32'); state.requests = []; state.ready = []; state.settings = { wslIntegration: { distros: ['OtherDistro'], enableIntegrationWithDefaultWslDistro: false } }; });
afterEach(() => restore());
it('preserves existing integrations and retries only the offered WSL recovery action after warming the distro', async () => {
  state.ready = [null, null, '1.0'];
  await ensureFleetDockerIntegration({ dir: '\\\\wsl.localhost\\ExampleDistro\\home\\example\\qwen-serving' });
  expect(state.requests).toContainEqual({ path: '/app/settings', body: { wslIntegration: { distros: ['OtherDistro', 'ExampleDistro'], enableIntegrationWithDefaultWslDistro: false } } });
  expect(state.requests).toContainEqual({ path: '/action', body: { action: 'Restart the WSL integration' } });
});
it('leaves healthy integrations alone and refuses an incompatible Desktop settings schema', async () => {
  const project = { dir: '\\\\wsl.localhost\\ExampleDistro\\home\\example\\qwen-serving' };
  state.ready = ['1.0'];
  await ensureFleetDockerIntegration(project);
  expect(state.requests).toEqual([]);
  state.settings = {};
  await expect(ensureFleetDockerIntegration(project)).rejects.toThrow('Enable this model distro');
  expect(state.requests.every(r => !r.body)).toBe(true);
});

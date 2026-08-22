import { describe, it, expect, vi } from 'vitest';
import { resolveAgentProviderPin } from './appTaskProviderPin.js';

// Provider registry for the walk: a CLI/TUI harness pair the agent can actually
// run on, and two api-only backends that can only ever return text.
const TYPES = {
  'claude-cli': 'cli',
  'opencode-tui': 'tui',
  ollama: 'api',
  lmstudio: 'api'
};
const getProviderType = vi.fn(async (id) => TYPES[id] ?? null);

const resolve = (appPin, schedulePin, readSchedulePin) => resolveAgentProviderPin({
  appPin,
  readSchedulePin: readSchedulePin || (async () => schedulePin),
  taskType: 'ux',
  appName: 'Acme',
  getProviderType
});

describe('resolveAgentProviderPin', () => {
  it('honors a harness-capable per-app pin over the schedule pin', async () => {
    const res = await resolve(
      { providerId: 'claude-cli', model: 'opus' },
      { providerId: 'opencode-tui', model: 'qwen' }
    );
    expect(res).toMatchObject({ providerId: 'claude-cli', model: 'opus', skipReason: null });
  });

  it('falls back to the schedule pin (provider AND model) when the app pin is api-only', async () => {
    const res = await resolve(
      { providerId: 'ollama', model: 'llama-3' },
      { providerId: 'claude-cli', model: 'opus' }
    );
    // The model travels with the provider: an api model name is not necessarily
    // valid for the CLI provider that replaces it.
    expect(res).toMatchObject({ providerId: 'claude-cli', model: 'opus', healedFrom: 'ollama', skipReason: null });
  });

  it('refuses to heal onto an UNRESOLVABLE schedule pin', async () => {
    // A deleted/renamed/typo'd pin has no known type — adopting it would re-wedge
    // the task on a doomed provider under a misleading "healed" line.
    const res = await resolve({ providerId: 'ollama' }, { providerId: 'deleted-provider' });
    expect(res).toMatchObject({ providerId: 'ollama', healedFrom: null, skipReason: 'provider-not-agent-capable' });
  });

  it('reports not-agent-capable when BOTH pins are api-only', async () => {
    const res = await resolve({ providerId: 'ollama' }, { providerId: 'lmstudio' });
    expect(res.skipReason).toBe('provider-not-agent-capable');
  });

  it('resolves the schedule pin when the app pins nothing', async () => {
    const res = await resolve({}, { providerId: 'claude-cli', model: 'opus' });
    expect(res).toMatchObject({ providerId: 'claude-cli', model: 'opus', skipReason: null });
  });

  it('keeps an app model pinned without a provider, over the schedule pin model', async () => {
    const res = await resolve({ model: 'sonnet' }, { providerId: 'claude-cli', model: 'opus' });
    expect(res).toMatchObject({ providerId: 'claude-cli', model: 'sonnet' });
  });

  it('leaves both null when nothing is pinned anywhere (inherit the default agent)', async () => {
    const res = await resolve({}, { providerId: null, model: null });
    expect(res).toMatchObject({ providerId: null, model: null, skipReason: null });
  });

  it('flags an api-only SCHEDULE pin the app did not override', async () => {
    const res = await resolve({}, { providerId: 'ollama' });
    expect(res).toMatchObject({ providerId: 'ollama', skipReason: 'provider-not-agent-capable' });
  });

  // The schedule pin is a THUNK so an already-usable per-app pin never pays for
  // the read — and no branch may read it twice.
  it('reads the schedule pin lazily, and at most once', async () => {
    const readSchedulePin = vi.fn(async () => ({ providerId: 'claude-cli' }));
    await resolve({ providerId: 'claude-cli' }, null, readSchedulePin);
    expect(readSchedulePin).not.toHaveBeenCalled();

    await resolve({ providerId: 'ollama' }, null, readSchedulePin);
    expect(readSchedulePin).toHaveBeenCalledTimes(1);
  });

  it('survives a schedule-pin read that throws', async () => {
    const res = await resolve({ providerId: 'ollama' }, null, async () => { throw new Error('nope'); });
    expect(res.skipReason).toBe('provider-not-agent-capable');
  });
});

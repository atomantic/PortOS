import { describe, it, expect } from 'vitest';
import { bodyErrorMessage, btwBodySchema, spawnBodySchema, spawnTuiBodySchema } from './requestSchemas.js';

// #10024 — the runner spawns processes from these bodies, so a wrong-typed
// field must bounce as a 400 before it reaches the env builder or the spawn.
describe('cos-runner request schemas', () => {
  it('accepts the body the server actually sends (undefined dropped, nulls tolerated)', () => {
    expect(spawnBodySchema.safeParse({
      agentId: 'a', taskId: 't', prompt: 'p', workspacePath: null, model: null,
      envVars: { A: '1' }, providerAuth: { id: 'x' }, cliCommand: 'claude', cliArgs: ['-p'],
    }).success).toBe(true);
    expect(spawnTuiBodySchema.safeParse({
      agentId: 'a', taskId: 't', command: 'claude', args: [], cols: 80, rows: 24, providerAuth: null, doneSentinelPath: null,
    }).success).toBe(true);
  });

  it('rejects wrong-typed fields and names them', () => {
    const bad = spawnBodySchema.safeParse({ agentId: { $ne: 1 }, cliArgs: 5, envVars: ['x'] });
    expect(bad.success).toBe(false);
    const message = bodyErrorMessage(bad.error);
    for (const field of ['agentId:', 'cliArgs:', 'envVars:']) expect(message).toContain(field);
    expect(spawnTuiBodySchema.safeParse({ args: 'rm -rf' }).success).toBe(false);
    expect(spawnTuiBodySchema.safeParse({ cols: 0 }).success).toBe(false);
    expect(btwBodySchema.safeParse({ message: '' }).success).toBe(false);
    expect(btwBodySchema.safeParse({}).success).toBe(false);
  });
});

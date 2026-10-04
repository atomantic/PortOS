import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMaintenanceAdmission } from '../../maintenanceAdmission.js';
import { createRunsRoutes } from './runs.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('retains admission after an HTTP disconnect until handler completion and child transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'run-admission-')); roots.push(root);
  const gate = createMaintenanceAdmission(root);
  let created; let child;
  const pending = new Promise(resolve => { created = resolve; });
  const runner = { createRun: () => pending, executeApiRun: vi.fn(() => {
    child = gate.admit('api-run', 'example-run', { continuation: true });
    return Promise.resolve('example-run');
  }) };
  const router = createRunsRoutes(runner, {
    asyncHandler: handler => handler,
    withRunAdmission: handler => (req, res) => gate.run('manual-run', 'Runs', () => handler(req, res)),
  });
  const handler = router.stack.find(layer => layer.route?.methods.post).route.stack[0].handle;
  const res = Object.assign(new EventEmitter(), { status() { return this; }, json: vi.fn() });
  const running = handler({ body: { providerId: 'example', prompt: 'Example thought' } }, res);
  gate.begin({ reason: 'Work', owner: 'Operator' });
  res.emit('close');
  expect(gate.status().state).toBe('draining');
  expect(runner.executeApiRun).not.toHaveBeenCalled();
  created({ runId: 'example-run', provider: { type: 'api' }, metadata: {} });
  await running;
  expect(runner.executeApiRun).toHaveBeenCalledTimes(1);
  expect(gate.status().blockers.map(op => op.kind)).toEqual(['api-run']);
  await child.finish();
  expect(gate.status().state).toBe('ready');
});

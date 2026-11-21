/**
 * Test-only harness for the per-router host-control suites (#16114).
 *
 * Since #16018 every `/api` write needs operator authority by default, and the
 * principal matrix (remote anonymous, spoofed dev proxy, Basic, scoped peer,
 * local, agent session) is asserted once in services/authGate.test.js, with the
 * mounted route graph pinned by server/test/guards/modules/hostControlCoverage.test.js. A router suite
 * keeps only what those cannot see: that the router still works behind the real
 * gates for a local operator and a delegated `PORTOS_API_TOKEN` agent session,
 * and the refusal of any HOST_CONTROL_GET_ROUTES read it serves.
 *
 * The calling suite owns its mocks; it must double `services/auth.js` so that
 * `isAuthEnabled()` reads the `auth.enabled` flag it passes here, and redirect
 * the data root (`makePathsProxy` + `lazyTempDataRoot`), because the agent
 * session is persisted to `auth-sessions.json`. A CoS worktree's own `data/`
 * is exempt from the real-data write guard, so only CI catches a missing redirect. Gates and the
 * session store load lazily so a suite's `vi.doMock` calls apply first.
 */
import express from 'express';
import { expect } from 'vitest';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

export const REMOTE_ADDRESS = '192.0.2.10';

/** `mounts` is `[[mountPath, router], …]`, mounted behind authGate and hostControlRouteGate. */
export const hostControlApp = async (address, mounts) => {
  const { authGate, hostControlRouteGate } = await import('../services/authGate.js');
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  for (const [mount, router] of mounts) app.use(mount, router);
  app.use(errorMiddleware);
  return app;
};

/** Sends `[method, path, body]`; a Buffer body goes as `application/octet-stream`. */
export const callRoute = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  if (Buffer.isBuffer(body)) pending.set('Content-Type', 'application/octet-stream');
  return body === undefined ? pending : pending.send(body);
};

/** A remote caller on a password-free install is refused before `effect` runs. */
export const expectRemoteRefusal = async (mounts, [method, path, body, effect]) => {
  const response = await callRoute(await hostControlApp(REMOTE_ADDRESS, mounts), [method, path, body]);
  expect([response.status, response.body.code], `${method} ${path}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
  expect(effect).not.toHaveBeenCalled();
};

/**
 * Each `[method, path, body, effect, status]` workflow answers `status` and
 * calls `effect` once for a local password-free caller, then again for a
 * delegated agent session with a password set. `localPath(path)` names paths
 * whose router admits loopback sockets only, so the agent arrives locally there.
 * `rearm()` runs before each principal's pass to reset stateful doubles.
 */
export const expectAuthorizedWorkflows = async ({ auth, mounts, workflows, headers = {}, localPath = () => false, rearm = () => {} }) => {
  const { createSession } = await import('../services/auth.js');
  const agent = await createSession({ label: 'agent' });
  for (const [enabled, address, credentials] of [
    [false, '127.0.0.1', {}],
    [true, REMOTE_ADDRESS, { Authorization: `Bearer ${agent.token}` }],
  ]) {
    auth.enabled = enabled;
    rearm();
    for (const [method, path, body, effect, status] of workflows) {
      const before = effect.mock.calls.length;
      const app = await hostControlApp(localPath(path) ? '127.0.0.1' : address, mounts);
      const response = await callRoute(app, [method, path, body], { ...headers, ...credentials });
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
      // A 202 may finish its work in the background.
      await expect.poll(() => effect.mock.calls.length, { message: `${method} ${path}` }).toBe(before + 1);
    }
  }
};

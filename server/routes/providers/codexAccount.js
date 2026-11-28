import { Router } from 'express';
import { freshQuerySchema } from '../../lib/queryValidation.js';
import { assertHostControl, requestHasHostControl } from '../../services/authGate.js';
import { observeModelResource } from '../../services/modelObservation.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import {
  cancelCodexChatGptLogin,
  codexLogout,
  listCodexModels,
  getCodexAccountReadiness,
  peekCodexAccountReadiness,
  peekCodexModelCatalog,
  startCodexChatGptLogin,
} from '../../services/codexAppServer.js';
import { codexLoginCancelSchema, codexLoginStartSchema } from '../../lib/providerValidation.js';

export function createCodexAccountRoutes() {
  const router = Router();

  const accountObservation = observeModelResource('codex-account', async ({ fresh }) => ({
    readiness: await getCodexAccountReadiness({ fresh }),
  }));

  /**
   * Is a ChatGPT subscription signed in, and is it usable right now?
   *
   * The Codex CLI/TUI cards could already say whether the `codex` binary
   * exists; they could not say whether the account behind it is signed in, on
   * which plan, expired, or out of quota — the user learned that from a failed
   * agent transcript. The answer comes from the Codex app-server's own
   * `account/read`: PortOS never reads Codex's credential file and never holds
   * a token.
   *
   * LAZY BY CONTRACT. This is the call that may spawn `codex app-server`, and
   * authorized viewers can start it with a page fetch or subscription. Other
   * readers get the same cache-only snapshot as `GET /api/providers`.
   * `?fresh=1` requires host control and skips the TTL after sign-in.
   *
   * The payload carries a status, a plan name, and quota percentages. No token,
   * no account id, no email, no credential path.
   */
  router.get('/codex/account', asyncHandler(async (req, res) => {
    const fresh = validateRequest(freshQuerySchema, req.query).fresh === '1';
    if (fresh) assertHostControl(req);
    else if (!requestHasHostControl(req)) return res.json({ readiness: peekCodexAccountReadiness({ includeDiagnostics: false }) });
    res.json(await accountObservation.read({ fresh }));
  }));

  /**
   * Begin an explicit ChatGPT sign-in and return only the URL (browser flow) or
   * the verification URL plus short code (device-code flow) the user needs.
   *
   * A POST because it starts an OAuth flow — never a side effect of a read.
   * The response deliberately contains no token material, and `loginId` is the
   * bounded handle the cancel endpoint takes.
   */
  router.post('/codex/account/login', asyncHandler(async (req, res) => {
    const { deviceCode } = validateRequest(codexLoginStartSchema, req.body ?? {});
    res.json({ login: await startCodexChatGptLogin({ deviceCode }) });
  }));

  /**
   * Abandon the sign-in this PortOS started. The id must match the pending
   * login, so a stale tab cannot cancel a flow the user began afterwards.
   */
  router.post('/codex/account/login/cancel', asyncHandler(async (req, res) => {
    const { loginId } = validateRequest(codexLoginCancelSchema, req.body ?? {});
    res.json({ readiness: await cancelCodexChatGptLogin(loginId) });
  }));

  /**
   * Which models this ChatGPT subscription may run, from the app-server's own
   * catalog rather than a hard-coded list — so the picker reflects the account's
   * actual plan.
   *
   * LAZY, like `/codex/account`: only an explicit page fetch reaches it.
   * `?fresh=1` skips the TTL after a plan change or a sign-in.
   *
   * `models: null` means NEVER FETCHED, `[]` means fetched-and-empty, and a read
   * that fails returns the last-known-good list alongside `error` — the client
   * must not repaint an empty picker because one call timed out.
   */
  router.get('/codex/models', asyncHandler(async (req, res) => {
    const fresh = validateRequest(freshQuerySchema, req.query).fresh === '1';
    if (fresh) assertHostControl(req);
    else if (!requestHasHostControl(req)) return res.json(peekCodexModelCatalog({ includeDiagnostics: false }));
    res.json(await listCodexModels({ fresh }));
  }));

  /** Sign out. Codex drops its own credentials; PortOS has none to clear. */
  router.post('/codex/account/logout', asyncHandler(async (_req, res) => {
    res.json({ readiness: await codexLogout() });
  }));

  return router;
}

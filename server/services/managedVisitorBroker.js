import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite, ensureDir } from '../lib/fileCore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { visitorCancellationSchema, visitorCredentialSchema, visitorAdmissionSchema, visitorScopeSchema, visitorActionSchema, visitorCredentialDocumentSchema,
  visitorHostAdmissionSchema, visitorHostObservationSchema, visitorHostActionSchema, visitorIdSchema } from '../lib/managedVisitorValidation.js';

const hash = token => createHash('sha256').update(token).digest('hex');
const fail = (message, status = 409) => new ServerError(message, { status, code: 'MANAGED_VISITOR_UNAVAILABLE' });
const scopeKeys = ['appId', 'individualId', 'individualSessionId', 'worldId', 'epoch'];
const publicCredential = ({ digest, ...record }) => record;
export const managedVisitorContract = Object.freeze({ version: 1, bodies: ['fly-v1'], controllerRaster: { width: 8, height: 4, channels: 3 },
  actions: ['start', 'pause', 'rest', 'move', 'leave'], expiryEnforced: true, admissionDeadline: true });
export function supportsManagedVisitors(capabilities) {
  const value = capabilities?.managedVisitors;
  return value?.version === 1 && value.expiryEnforced === true && value.admissionDeadline === true && Array.isArray(value.bodies) && value.bodies.every(v => typeof v === 'string')
    && value.bodies.includes('fly-v1') && Array.isArray(value.actions) && value.actions.every(v => typeof v === 'string')
    && value.controllerRaster?.width === 8 && value.controllerRaster?.height === 4 && value.controllerRaster?.channels === 3
    && managedVisitorContract.actions.every(action => value.actions?.includes(action));
}

/** Local credentials persist; ephemeral admissions do not survive broker restart.
 * No peer sync, AI provider, arbitrary host URL or private runtime payload is accepted. */
export function createManagedVisitorBroker({ path, getApp, host, now = Date.now }) {
  const queue = createFileWriteQueue(), sessions = new Map(), pendingAdmissions = new Map();
  const wallNow = now;
  let lastTime = wallNow();
  if (!Number.isSafeInteger(lastTime) || lastTime < 0 || !Number.isSafeInteger(lastTime + 300000)) throw fail('Broker boot clock is invalid.');
  const bootQuarantineUntil = lastTime + 300000;
  const confirmedSessions = new Map(), confirmedScopes = new Map();
  const originalScopeKey = scope => JSON.stringify([scope.appId, scope.individualId, scope.individualSessionId, scope.worldId]);
  function remember(map, key, value) { map.set(key, value); if (map.size > 256) map.delete(map.keys().next().value); }
  function unknownCleanupBound(scope) { return confirmedScopes.has(originalScopeKey(scope)) || time() >= bootQuarantineUntil ? null : bootQuarantineUntil; }
  function time() {
    const current = wallNow();
    if (!Number.isSafeInteger(current) || current < lastTime) {
      for (const session of [...sessions.values()]) close(session).catch(() => null);
      throw fail('Broker clock changed; visitor authority revoked.');
    }
    lastTime = current; return current;
  }
  const read = async () => {
    const metadata = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!metadata) return { schemaVersion: 1, credentials: [] };
    if (metadata.size > 65536) throw fail('Managed visitor credential store exceeds its bound.');
    const document = await readFile(path, 'utf8').then(JSON.parse).catch(() => { throw fail('Managed visitor credential store is unreadable.'); });
    const result = visitorCredentialDocumentSchema.safeParse(document);
    if (!result.success || new Set(result.data.credentials.map(c => c.appId)).size !== result.data.credentials.length) throw fail('Managed visitor credential store is incompatible.');
    return result.data;
  };
  async function write(document) {
    const text = JSON.stringify(visitorCredentialDocumentSchema.parse(document));
    if (Buffer.byteLength(text) > 65536) throw fail('Managed visitor credential capacity reached.');
    await ensureDir(dirname(path)); await atomicWrite(path, text);
  }
  async function app(id) { const value = await getApp(id); if (!value || value.archived) throw fail('Managed app is unavailable.', 403); }
  async function credential(auth) {
    await app(auth.appId);
    const current = (await read()).credentials.find(record => record.appId === auth.appId);
    if (!current || current.digest !== auth.digest || current.expiresAt <= time()) throw fail('Managed app credential expired or revoked.', 401);
    return current;
  }
  async function authenticate(token) {
    if (typeof token !== 'string' || !/^mv1_[a-f0-9]{64}$/.test(token)) throw fail('Managed app credential required.', 401);
    const digest = hash(token), record = (await read()).credentials.find(record => timingSafeEqual(Buffer.from(record.digest, 'hex'), Buffer.from(digest, 'hex')));
    if (!record) throw fail('Managed app credential required.', 401);
    const auth = { appId: record.appId, digest }; await credential(auth); return auth;
  }
  async function close(session) {
    session.revoked = true;
    // Keep an unresolved cleanup receipt so a retry cannot falsely acknowledge return.
    sessions.set(session.id, session);
    const acknowledged = wallNow() >= (session.admissionDeadline ?? session.hostExpiresAt) || session.hostId !== null && await host.leave(session.hostId, session.scope)
      .then(result => result?.status === 'left' && result.sessionId === session.hostId && scopeKeys.every(key => result[key] === session.scope[key]), () => false);
    if (acknowledged) {
      sessions.delete(session.id);
      remember(confirmedSessions, session.id, { ...session.scope });
      if (session.provenAdmission) remember(confirmedScopes, originalScopeKey(session.scope), true);
    }
    return acknowledged;
  }
  async function revokeSessions(appId) { await Promise.all([...sessions.values()].filter(s => s.scope.appId === appId).map(close)); }
  async function provision(appId, input) {
    const value = visitorCredentialSchema.parse(input); await app(appId);
    return queue(async () => {
      const document = await read(), token = `mv1_${randomBytes(32).toString('hex')}`;
      const record = { appId, digest: hash(token), individualIds: [...new Set(value.individualIds)], worldIds: [...new Set(value.worldIds)], createdAt: time(), expiresAt: time() + value.ttlMs };
      document.credentials = document.credentials.filter(record => record.appId !== appId);
      if (document.credentials.length >= 64) throw fail('Managed credential capacity reached.');
      document.credentials.push(record); await write(document);
      await revokeSessions(appId); return { ...publicCredential(record), credential: token };
    });
  }
  async function revoke(appId) {
    return queue(async () => {
      const document = await read(); document.credentials = document.credentials.filter(record => record.appId !== appId);
      await write(document); await revokeSessions(appId); return { revoked: true };
    });
  }
  async function capabilities(auth) {
    const c = await credential(auth), capability = await host.capabilities();
    return { version: 1, available: supportsManagedVisitors(capability), appId: auth.appId, worldIds: c.worldIds, individualIds: c.individualIds,
      contract: managedVisitorContract, reason: supportsManagedVisitors(capability) ? null : 'Managed host has not negotiated the nonhumanoid visitor contract.' };
  }
  function validateResult(schema, result, expected) {
    const parsed = schema.safeParse(result);
    if (!parsed.success || scopeKeys.some(key => parsed.data[key] !== expected[key])) throw fail('Host response does not match the scoped visitor contract.');
    return parsed.data;
  }
  async function admit(auth, input) {
    const value = visitorAdmissionSchema.parse(input), c = await credential(auth);
    if (!c.individualIds.includes(value.individualId) || !c.worldIds.includes(value.worldId)) throw fail('Visitor is outside the owner-approved app scope.', 403);
    if (!supportsManagedVisitors(await host.capabilities())) throw fail('Managed host lacks the required nonhumanoid capability.');
    const key = JSON.stringify([auth.appId, value.individualId]);
    for (const session of [...sessions.values()]) if (session.expiresAt <= time()) await close(session);
    if (sessions.size + pendingAdmissions.size >= 64 || pendingAdmissions.has(key) || [...sessions.values()].some(s => s.key === key)) throw fail('Individual already visiting or admission capacity reached.');
    const attempt = { scope: { appId: auth.appId, individualId: value.individualId, individualSessionId: value.individualSessionId, worldId: value.worldId }, canceled: false };
    pendingAdmissions.set(key, attempt);
    let candidate = null;
    return (async () => {
      const begin = time(), ttlMs = Math.min(value.ttlMs, c.expiresAt - begin);
      if (ttlMs < 1000) throw fail('Credential expires too soon for admission.');
      candidate = { id: randomUUID(), hostId: null, scope: { ...attempt.scope, epoch: null }, key, digest: auth.digest, expiresAt: begin + ttlMs, hostExpiresAt: begin + ttlMs, admissionDeadline: begin + ttlMs, revoked: true };
      const response = await host.admit({ version: 1, appId: auth.appId, ...value, ttlMs }, { deadlineMs: begin + ttlMs });
      const parsed = visitorHostAdmissionSchema.safeParse(response);
      const scope = { appId: auth.appId, individualId: value.individualId, individualSessionId: value.individualSessionId, worldId: value.worldId, epoch: response?.epoch };
      if (!parsed.success || scopeKeys.some(key => parsed.data[key] !== scope[key])) {
        // A malformed acknowledgement may still represent a live admission. Clean up
        // only using the request's original identity/world and syntactically valid lease keys.
        if (visitorIdSchema.safeParse(response?.sessionId).success && visitorIdSchema.safeParse(response?.epoch).success) {
          candidate = { ...candidate, hostId: response.sessionId, scope };
        }
        throw fail('Host returned an invalid scoped admission.');
      }
      const result = parsed.data;
      const session = { id: randomUUID(), hostId: result.sessionId, scope, key, digest: auth.digest, expiresAt: result.expiresAt, hostExpiresAt: result.expiresAt, admissionDeadline: begin + ttlMs, sequence: -1, frameId: -1, pending: false };
      candidate = session;
      session.expiresAt = Math.min(result.expiresAt, begin + ttlMs);
      const valid = session.expiresAt > time() && result.expiresAt <= time() + ttlMs;
      // Rotation while an admission is pending must not publish fresh authority from the old credential.
      session.provenAdmission = valid;
      const current = await credential(auth).then(() => true, () => false);
      if (!valid || !current || attempt.canceled) throw fail('Admission expired or credential changed during negotiation.');
      sessions.set(session.id, session);
      remember(confirmedScopes, originalScopeKey(session.scope), true);
      return { ...result, sessionId: session.id, expiresAt: session.expiresAt };
    })().catch(async error => { if (candidate) await close(candidate); throw error; })
      .finally(() => { if (pendingAdmissions.get(key) === attempt) pendingAdmissions.delete(key); });
  }
  async function sessionFor(auth, id, input) {
    await credential(auth);
    const session = sessions.get(id);
    if (!session || session.revoked || session.digest !== auth.digest || session.expiresAt <= time() || scopeKeys.some(key => (key === 'appId' ? auth.appId : input[key]) !== session.scope[key])) throw fail('Visitor session scope, epoch or expiry mismatch.', 403);
    if (session.pending) throw fail('A visitor operation is already pending.');
    return session;
  }
  async function operate(auth, id, input, observation) {
    const request = (observation ? visitorScopeSchema : visitorActionSchema).parse(input), session = await sessionFor(auth, id, request);
    if (!observation && request.sequence !== session.sequence + 1) throw fail('Visitor action sequence is stale or out of order.');
    session.pending = true;
    return (async () => {
      const reply = await (observation ? host.observe(session.hostId, session.scope) : host.action(session.hostId, { ...session.scope, sequence: request.sequence, action: request.action }));
      const stillValid = await credential(auth).then(() => true, () => false);
      if (!stillValid || session.revoked || sessions.get(id) !== session || session.expiresAt <= time()) throw fail('Visitor authority changed while the host operation was pending.');
      const result = validateResult(observation ? visitorHostObservationSchema : visitorHostActionSchema, reply, session.scope);
      if (result.sessionId !== session.hostId) throw fail('Host session mismatch.');
      if (observation) {
        if (result.frameId <= session.frameId || result.capturedAtMs > time() || time() - result.capturedAtMs > 250) throw fail('Host observation is stale or future-dated.');
        session.frameId = result.frameId;
      } else {
        const expected = { start: 'running', pause: 'paused', rest: 'resting', move: 'running', leave: 'left' }[request.action.type];
        if (result.sequence !== request.sequence || result.status !== expected || result.expiresAt !== session.hostExpiresAt) throw fail('Host action sequence/status mismatch.');
        session.sequence = result.sequence;
        if (request.action.type === 'leave') sessions.delete(id);
      }
      return { ...result, sessionId: id, ...(observation ? {} : { expiresAt: session.expiresAt }) };
    })().catch(async () => { await close(session); throw fail('Host operation unavailable or inconsistent; visitor authority revoked.'); })
      .finally(() => { session.pending = false; });
  }

  async function leave(auth, id, input) {
    const request = visitorScopeSchema.parse(input), c = await credential(auth);
    if (!c.individualIds.includes(request.individualId) || !c.worldIds.includes(request.worldId)) throw fail('Cleanup is outside the approved app scope.', 403);
    const session = sessions.get(id);
    if (!session) {
      const receipt = confirmedSessions.get(id);
      if (receipt && scopeKeys.some(key => receipt[key] !== (key === 'appId' ? auth.appId : request[key]))) throw fail('Visitor cleanup scope mismatch.', 403);
      if (!receipt && time() < bootQuarantineUntil) throw fail('Unknown cleanup after broker restart is unconfirmed until the maximum host lease deadline.');
      return { version: 1, appId: auth.appId, ...request, sessionId: id, status: 'left' };
    }
    if (session.scope.appId !== auth.appId || scopeKeys.some(key => (key === 'appId' ? auth.appId : request[key]) !== session.scope[key])) throw fail('Visitor cleanup scope mismatch.', 403);
    if (!await close(session)) throw fail('Host cleanup is unconfirmed; retain paused ownership until retry or expiry.');
    return { version: 1, appId: auth.appId, ...request, sessionId: id, status: 'left' };
  }
  async function cancelAdmission(auth, input) {
    const request = visitorCancellationSchema.parse(input), c = await credential(auth);
    if (!c.individualIds.includes(request.individualId) || !c.worldIds.includes(request.worldId)) throw fail('Cancellation is outside the approved app scope.', 403);
    const matches = scope => scope.appId === auth.appId && Object.keys(request).every(key => scope[key] === request[key]);
    for (const attempt of pendingAdmissions.values()) if (matches(attempt.scope)) attempt.canceled = true;
    await Promise.all([...sessions.values()].filter(session => matches(session.scope)).map(close));
    const pending = [...pendingAdmissions.values()].some(attempt => matches(attempt.scope));
    const unresolved = [...sessions.values()].filter(session => matches(session.scope));
    const bootBound = unknownCleanupBound({ appId: auth.appId, ...request });
    return { version: 1, appId: auth.appId, ...request, confirmed: !pending && !unresolved.length && bootBound === null, pending,
      expiresAt: pending ? null : unresolved.length || bootBound !== null ? Math.max(bootBound ?? 0, ...unresolved.map(session => session.admissionDeadline ?? session.hostExpiresAt)) : null };
  }
  return { authenticate, provision, revoke, capabilities, admit, leave, cancelAdmission,
    listCredentials: async () => (await read()).credentials.map(publicCredential),
    observe: (auth, id, input) => operate(auth, id, input, true), action: (auth, id, input) => operate(auth, id, input, false) };
}

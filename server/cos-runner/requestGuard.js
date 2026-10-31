import { isBrowserRequest, isLoopbackHostname } from '../../lib/portosAuthCore.js';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*']);

// Parse an authority, not a URL: userinfo, paths and malformed ports must not
// turn an attacker-controlled Host into an allowed hostname.
const hostname = (value) => {
  if (typeof value !== 'string') return null;
  if (value === '::1' || value === '::') return value;
  const match = /^(?:\[([a-f\d:]+)\]|([a-z\d.-]+))(?::\d{1,5})?$/i.exec(value);
  return match ? (match[1] || match[2]).toLowerCase() : null;
};

export const runnerRequestRefusal = (req, { host = process.env.HOST } = {}) => {
  if (isBrowserRequest(req)) return 'BROWSER_REQUEST_REJECTED';
  const requestedHost = hostname(req.headers?.host);
  const configuredHost = hostname(host);
  if (requestedHost && (isLoopbackHostname(requestedHost)
    || (configuredHost && !WILDCARD_HOSTS.has(configuredHost) && requestedHost === configuredHost))) return null;
  return 'HOST_NOT_ALLOWED';
};

// Express and Engine.IO share this boundary; neither browser pages nor DNS
// rebinding names may borrow the runner's unauthenticated native-client access.
export const runnerRequestGuard = (req, res, next) => {
  const code = runnerRequestRefusal(req);
  if (!code) return next();
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Runner accepts only trusted native clients', code }));
};

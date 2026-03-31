import { join } from 'path';
import { readJSONFile, PATHS } from '../../lib/fileUtils.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { ServerError } from '../../lib/errorHandler.js';

const CONFIG_FILE = join(PATHS.data, 'openclaw', 'config.json');
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PATHS = {
  status: '/status',
  sessions: '/sessions',
  sessionMessages: '/sessions/:sessionId/messages',
  sendMessage: '/sessions/:sessionId/messages'
};

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function withLeadingSlash(path) {
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

function joinUrl(baseUrl, path) {
  return new URL(withLeadingSlash(path), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function buildPath(template, params = {}) {
  return Object.entries(params).reduce(
    (path, [key, value]) => path.replaceAll(`:${key}`, encodeURIComponent(String(value))),
    template
  );
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.messages)) return value.messages;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function parseUpstreamBody(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function extractMessageContent(value) {
  if (typeof value === 'string') return value;
  if (!value) return '';

  if (Array.isArray(value)) {
    return value.map(extractMessageContent).filter(Boolean).join('\n\n');
  }

  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.body === 'string') return value.body;
    if (typeof value.message === 'string') return value.message;
    if (value.parts) return extractMessageContent(value.parts);
    if (value.content?.parts) return extractMessageContent(value.content.parts);
  }

  return '';
}

function normalizeRole(input) {
  const role = String(input || '').toLowerCase();
  if (['assistant', 'model', 'agent', 'bot'].includes(role)) return 'assistant';
  if (['user', 'operator', 'human'].includes(role)) return 'user';
  if (['system', 'tool'].includes(role)) return role;
  return role || 'assistant';
}

function normalizeSession(session) {
  const id = pickFirst(session?.id, session?.sessionId, session?.slug, session?.name, session?.title);
  if (!id) return null;

  return {
    id: String(id),
    title: pickFirst(session?.title, session?.label, session?.name, session?.sessionId, id),
    label: pickFirst(session?.label, session?.name, session?.title, id),
    status: pickFirst(session?.status, session?.state, null) || null,
    messageCount: pickFirst(session?.messageCount, session?.messagesCount, session?.count, null),
    lastMessageAt: pickFirst(session?.lastMessageAt, session?.updatedAt, session?.lastActivityAt, session?.createdAt, null),
    raw: session
  };
}

function normalizeMessage(message, index = 0) {
  return {
    id: pickFirst(message?.id, message?.messageId, `${message?.createdAt || message?.timestamp || 'message'}-${index}`),
    role: normalizeRole(pickFirst(message?.role, message?.author, message?.sender, message?.type)),
    content: extractMessageContent(pickFirst(message?.content, message?.text, message?.body, message?.message, message)),
    createdAt: pickFirst(message?.createdAt, message?.timestamp, message?.time, message?.date, null),
    status: pickFirst(message?.status, message?.state, null),
    raw: message
  };
}

function normalizeStatusPayload(payload, config, reachable, errorMessage) {
  return {
    configured: config.configured,
    enabled: config.enabled,
    reachable,
    label: pickFirst(payload?.label, payload?.name, config.label, 'OpenClaw Runtime'),
    defaultSession: pickFirst(payload?.defaultSession, payload?.defaultSessionId, config.defaultSession, null) || null,
    message: errorMessage || pickFirst(payload?.message, payload?.statusMessage, null) || null,
    runtime: payload && typeof payload === 'object' ? payload : null
  };
}

async function loadConfig() {
  const fileConfig = await readJSONFile(CONFIG_FILE, {}, { logError: false });
  const envEnabled = parseBoolean(process.env.OPENCLAW_ENABLED);
  const enabled = pickFirst(envEnabled, fileConfig.enabled, true);
  const baseUrl = pickFirst(process.env.OPENCLAW_BASE_URL, fileConfig.baseUrl, '').trim();
  const configured = enabled !== false && Boolean(baseUrl);

  return {
    enabled,
    configured,
    baseUrl,
    authToken: pickFirst(process.env.OPENCLAW_AUTH_TOKEN, fileConfig.authToken, ''),
    authHeader: pickFirst(process.env.OPENCLAW_AUTH_HEADER, fileConfig.authHeader, 'Authorization'),
    authScheme: pickFirst(process.env.OPENCLAW_AUTH_SCHEME, fileConfig.authScheme, 'Bearer'),
    label: pickFirst(process.env.OPENCLAW_LABEL, fileConfig.label, 'OpenClaw Runtime'),
    defaultSession: pickFirst(process.env.OPENCLAW_DEFAULT_SESSION, fileConfig.defaultSession, null),
    timeoutMs: Number.parseInt(String(pickFirst(process.env.OPENCLAW_TIMEOUT_MS, fileConfig.timeoutMs, DEFAULT_TIMEOUT_MS)), 10) || DEFAULT_TIMEOUT_MS,
    paths: {
      ...DEFAULT_PATHS,
      ...(fileConfig.paths || {})
    }
  };
}

function getAuthHeaders(config) {
  if (!config.authToken) return {};
  const headerValue = config.authScheme === null || config.authScheme === ''
    ? config.authToken
    : `${config.authScheme} ${config.authToken}`;
  return {
    [config.authHeader]: headerValue
  };
}

async function openClawRequest(config, path, { method = 'GET', query, body } = {}) {
  if (!config.configured) {
    throw new ServerError('OpenClaw is not configured', {
      status: 503,
      code: 'OPENCLAW_UNCONFIGURED'
    });
  }

  const url = new URL(joinUrl(config.baseUrl, path));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  let response;
  try {
    response = await fetchWithTimeout(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        ...getAuthHeaders(config),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    }, config.timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ServerError('OpenClaw request timed out', {
        status: 504,
        code: 'OPENCLAW_TIMEOUT'
      });
    }

    throw new ServerError('OpenClaw runtime is unreachable', {
      status: 502,
      code: 'OPENCLAW_UNREACHABLE'
    });
  }

  let payload = null;
  if (response.status !== 204) {
    const text = await response.text();
    payload = parseUpstreamBody(text);
  }

  if (!response.ok) {
    const upstreamMessage = pickFirst(payload?.error, payload?.message, null);
    let code = 'OPENCLAW_REQUEST_FAILED';
    let message = upstreamMessage || `OpenClaw request failed with HTTP ${response.status}`;
    let status = 502;

    if (response.status === 401 || response.status === 403) {
      code = 'OPENCLAW_UNAUTHORIZED';
      message = upstreamMessage || 'OpenClaw rejected the configured credentials';
    } else if (response.status === 404) {
      code = 'OPENCLAW_NOT_FOUND';
      message = upstreamMessage || 'OpenClaw endpoint is not available';
    } else if (response.status >= 500) {
      code = 'OPENCLAW_UPSTREAM_ERROR';
      message = upstreamMessage || 'OpenClaw runtime failed to process the request';
      status = 503;
    }

    throw new ServerError(message, { status, code });
  }

  return payload;
}

export async function getRuntimeStatus() {
  const config = await loadConfig();
  if (!config.configured) {
    return normalizeStatusPayload(null, config, false, 'OpenClaw is not configured');
  }

  try {
    const payload = await openClawRequest(config, config.paths.status);
    return normalizeStatusPayload(payload, config, true, null);
  } catch (err) {
    if (err.code === 'OPENCLAW_NOT_FOUND') {
      try {
        await openClawRequest(config, config.paths.sessions);
        return normalizeStatusPayload(null, config, true, null);
      } catch (fallbackErr) {
        return normalizeStatusPayload(null, config, false, fallbackErr.message);
      }
    }

    return normalizeStatusPayload(null, config, false, err.message);
  }
}

export async function listSessions() {
  const config = await loadConfig();
  const payload = await openClawRequest(config, config.paths.sessions);
  const sessions = toArray(payload)
    .map(normalizeSession)
    .filter(Boolean);

  return {
    configured: true,
    reachable: true,
    label: config.label,
    defaultSession: config.defaultSession,
    sessions
  };
}

export async function getSessionMessages(sessionId, { limit = 50 } = {}) {
  const config = await loadConfig();
  const path = buildPath(config.paths.sessionMessages, { sessionId });
  const payload = await openClawRequest(config, path, { query: { limit } });
  const messages = toArray(payload)
    .map((message, index) => normalizeMessage(message, index))
    .filter(message => message.content || message.role || message.createdAt);

  return {
    configured: true,
    reachable: true,
    sessionId,
    messages
  };
}

export async function sendSessionMessage(sessionId, { message, context } = {}) {
  const config = await loadConfig();
  const path = buildPath(config.paths.sendMessage, { sessionId });
  const payload = await openClawRequest(config, path, {
    method: 'POST',
    body: {
      sessionId,
      message,
      text: message,
      content: message,
      role: 'user',
      ...(context !== undefined ? { context } : {})
    }
  });

  const normalizedReply = payload ? normalizeMessage(payload) : null;

  return {
    ok: true,
    configured: true,
    reachable: true,
    sessionId,
    message: normalizedReply
  };
}

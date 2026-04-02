import { join } from 'path';
import { readJSONFile, PATHS } from '../../lib/fileUtils.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { ServerError } from '../../lib/errorHandler.js';

const CONFIG_FILE = join(PATHS.data, 'openclaw', 'config.json');
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PATHS = {
  toolsInvoke: '/tools/invoke',
  responses: '/v1/responses'
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
    if (typeof value.output_text === 'string') return value.output_text;
    if (value.parts) return extractMessageContent(value.parts);
    if (value.content?.parts) return extractMessageContent(value.content.parts);
    if (Array.isArray(value.content)) return extractMessageContent(value.content);
    if (Array.isArray(value.output)) return extractMessageContent(value.output);
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
  const id = pickFirst(session?.key, session?.id, session?.sessionId, session?.slug, session?.name, session?.title);
  if (!id) return null;

  return {
    id: String(id),
    title: pickFirst(session?.title, session?.displayName, session?.label, session?.name, session?.sessionId, id),
    label: pickFirst(session?.label, session?.displayName, session?.name, session?.title, id),
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
  const baseUrlRaw = pickFirst(process.env.OPENCLAW_BASE_URL, fileConfig.baseUrl, '');
  let finalBaseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw.trim() : '';
  let configured = enabled !== false && Boolean(finalBaseUrl);

  if (configured && finalBaseUrl) {
    try {
      // Validate that baseUrl is a well-formed URL; invalid values should not mark the integration as configured.
      // This avoids later failures in URL-joining logic that would otherwise surface as generic "unreachable" errors.
      // eslint-disable-next-line no-new
      new URL(finalBaseUrl);
    } catch {
      configured = false;
      finalBaseUrl = '';
    }
  }

  return {
    enabled,
    configured,
    baseUrl: finalBaseUrl,
    authToken: pickFirst(process.env.OPENCLAW_AUTH_TOKEN, fileConfig.authToken, ''),
    authHeader: pickFirst(process.env.OPENCLAW_AUTH_HEADER, fileConfig.authHeader, 'Authorization'),
    authScheme: pickFirst(process.env.OPENCLAW_AUTH_SCHEME, fileConfig.authScheme, 'Bearer'),
    label: pickFirst(process.env.OPENCLAW_LABEL, fileConfig.label, 'OpenClaw Runtime'),
    defaultSession: pickFirst(process.env.OPENCLAW_DEFAULT_SESSION, fileConfig.defaultSession, null),
    defaultAgentId: pickFirst(process.env.OPENCLAW_DEFAULT_AGENT_ID, fileConfig.defaultAgentId, 'main'),
    timeoutMs: (() => { const raw = Number.parseInt(String(pickFirst(process.env.OPENCLAW_TIMEOUT_MS, fileConfig.timeoutMs, DEFAULT_TIMEOUT_MS)), 10); return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TIMEOUT_MS; })(),
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

async function openClawFetch(config, path, { method = 'GET', headers = {}, body, accept = 'application/json', timeoutMs } = {}) {
  if (!config.configured) {
    throw new ServerError('OpenClaw is not configured', {
      status: 503,
      code: 'OPENCLAW_UNCONFIGURED'
    });
  }

  try {
    return await fetchWithTimeout(joinUrl(config.baseUrl, path), {
      method,
      headers: {
        Accept: accept,
        ...getAuthHeaders(config),
        ...headers,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    }, timeoutMs ?? config.timeoutMs);
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
}

async function parseOpenClawError(response) {
  let payload = null;
  if (response.status !== 204) {
    const text = await response.text();
    payload = parseUpstreamBody(text);
  }

  const upstreamMessage = pickFirst(payload?.error?.message, payload?.error, payload?.message, null);
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

async function openClawRequest(config, path, options = {}) {
  const response = await openClawFetch(config, path, options);
  if (!response.ok) {
    await parseOpenClawError(response);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return parseUpstreamBody(text);
}

function normalizeAttachment(attachment = {}) {
  const mediaType = attachment.mediaType || attachment.mimeType || 'application/octet-stream';
  const sourceType = attachment.sourceType || (attachment.url ? 'url' : 'base64');
  const filename = attachment.filename || attachment.name || 'attachment';
  const kind = attachment.kind || (String(mediaType).startsWith('image/') ? 'image' : 'file');

  if (sourceType === 'url' && attachment.url) {
    return kind === 'image'
      ? {
          type: 'input_image',
          source: {
            type: 'url',
            url: attachment.url
          }
        }
      : {
          type: 'input_file',
          source: {
            type: 'url',
            url: attachment.url,
            filename
          }
        };
  }

  if (!attachment.data) return null;

  return kind === 'image'
    ? {
        type: 'input_image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: attachment.data
        }
      }
    : {
        type: 'input_file',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: attachment.data,
          filename
        }
      };
}

function buildContextText(context = {}) {
  const lines = [];
  if (context.appName) lines.push(`App context: ${context.appName}`);
  if (context.repoPath) lines.push(`Repository context: ${context.repoPath}`);
  if (context.directoryPath) lines.push(`Directory context: ${context.directoryPath}`);
  if (context.extraInstructions) lines.push(`Extra context: ${context.extraInstructions}`);
  if (lines.length === 0) return '';
  return `PortOS operator context:\n${lines.join('\n')}`;
}

function buildInput(message, context = {}, attachments = []) {
  const input = [];
  const contextText = buildContextText(context);
  const text = [contextText, message].filter(Boolean).join('\n\n');
  if (text) {
    input.push({
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text
      }]
    });
  }

  for (const attachment of attachments) {
    const normalized = normalizeAttachment(attachment);
    if (normalized) input.push(normalized);
  }

  return input;
}

async function invokeTool(config, tool, args = {}, sessionKey = 'main') {
  const payload = await openClawRequest(config, config.paths.toolsInvoke, {
    method: 'POST',
    body: {
      tool,
      args,
      sessionKey
    }
  });

  if (!payload?.ok) {
    throw new ServerError(pickFirst(payload?.error?.message, payload?.message, `OpenClaw tool failed: ${tool}`), {
      status: 502,
      code: 'OPENCLAW_TOOL_FAILED'
    });
  }

  return pickFirst(payload?.result?.details, payload?.result, payload?.details, payload);
}

export async function isConfigured() {
  const config = await loadConfig();
  return { configured: config.configured, enabled: config.enabled };
}

export async function getRuntimeStatus() {
  const config = await loadConfig();
  if (!config.configured) {
    return normalizeStatusPayload(null, config, false, 'OpenClaw is not configured');
  }

  try {
    const sessions = await invokeTool(config, 'sessions_list', {});
    return normalizeStatusPayload({
      defaultSession: config.defaultSession,
      sessionsCount: Array.isArray(sessions?.sessions) ? sessions.sessions.length : null
    }, config, true, null);
  } catch (err) {
    return normalizeStatusPayload(null, config, false, err.message);
  }
}

export async function listSessions() {
  const config = await loadConfig();
  if (!config.configured) {
    return {
      configured: false,
      reachable: false,
      sessions: [],
      defaultSession: config.defaultSession || null,
      label: config.label
    };
  }

  const payload = await invokeTool(config, 'sessions_list', {});
  const sessions = (payload?.sessions || [])
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
  const payload = await invokeTool(config, 'sessions_history', {
    sessionKey: sessionId,
    limit,
    includeTools: false
  });
  const messages = (payload?.messages || [])
    .map((message, index) => normalizeMessage(message, index))
    .filter(message => message.content || message.role || message.createdAt);

  return {
    configured: true,
    reachable: true,
    sessionId,
    messages
  };
}

export async function sendSessionMessage(sessionId, { message, context, attachments } = {}) {
  const config = await loadConfig();
  const payload = await openClawRequest(config, config.paths.responses, {
    method: 'POST',
    headers: {
      'x-openclaw-session-key': sessionId
    },
    body: {
      model: `openclaw:${config.defaultAgentId}`,
      user: sessionId,
      input: buildInput(message, context, attachments)
    }
  });

  const normalizedReply = {
    id: payload?.id || `response-${Date.now()}`,
    role: 'assistant',
    content: extractMessageContent(payload),
    createdAt: new Date().toISOString(),
    status: payload?.status || 'completed',
    raw: payload
  };

  return {
    ok: true,
    configured: true,
    reachable: true,
    sessionId,
    message: normalizedReply
  };
}

export async function streamSessionMessage(sessionId, { message, context, attachments } = {}, handlers = {}) {
  const config = await loadConfig();
  const response = await openClawFetch(config, config.paths.responses, {
    method: 'POST',
    accept: 'text/event-stream',
    headers: {
      'x-openclaw-session-key': sessionId
    },
    timeoutMs: 0,
    body: {
      model: `openclaw:${config.defaultAgentId}`,
      user: sessionId,
      stream: true,
      input: buildInput(message, context, attachments)
    }
  });

  if (!response.ok) {
    await parseOpenClawError(response);
  }

  return {
    config,
    response,
    stream: response.body,
    contentType: response.headers.get('content-type') || '',
    handlers
  };
}

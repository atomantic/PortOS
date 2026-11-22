/**
 * Agent Client Protocol (ACP) wire helpers for the PortOS stdio adapter: JSON-RPC line framing, SSE parsing, session records and PortOS→ACP update translation.
 *
 * `scripts/portos-acp.js` is the only caller. It bridges an ACP editor (Zed,
 * VS Code, JetBrains, Neovim) to the running local PortOS server; this module
 * holds everything about that bridge that needs no I/O so it can be pinned by
 * unit tests. The adapter owns no provider keys, prompts or tools: Ask
 * Yourself and the Persistent Mind keep every capability boundary server-side,
 * and the translation here only re-shapes what those routes already stream.
 *
 * Builtins only (none, in fact): the adapter must load from a bare checkout,
 * because an editor launches it directly (see scripts/pre-install-entrypoints.test.js).
 */

/** The ACP protocol major version this adapter speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC 2.0 error codes, plus the two ACP reserves (`-32000` auth, `-32002` missing resource). */
export const JSON_RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
});

/**
 * The two backends an ACP session can talk to. `ask` is Ask Yourself (read-only
 * retrieval over the user's own records, tool-free); `mind` is the resident
 * Persistent Mind turn queue, whose capability grants stay exactly as the user
 * configured them in PortOS.
 */
export const ACP_SESSION_MODES = Object.freeze([
  Object.freeze({
    id: 'ask',
    name: 'Ask Yourself',
    description: 'Digital Twin answers grounded in your Brain, Memory, Autobiography, Goals, Calendar and Catalog. Read-only and tool-free.',
  }),
  Object.freeze({
    id: 'mind',
    name: 'Persistent Mind',
    description: 'Messages the resident Persistent Mind. It replies with its own capability grants exactly as configured in PortOS.',
  }),
]);

export const ACP_MODE_IDS = Object.freeze(ACP_SESSION_MODES.map((mode) => mode.id));
export const DEFAULT_ACP_MODE = 'ask';

/** One JSON-RPC message per line; a longer line is refused instead of buffered without bound. */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;
/** Session records the adapter keeps on disk; the oldest fall off first. */
export const MAX_ACP_SESSION_RECORDS = 200;
/** Mind message ids remembered per session, enough to replay its recent exchange on `session/load`. */
export const MAX_ACP_SESSION_MESSAGE_IDS = 200;
export const ACP_SESSION_LIST_PAGE_SIZE = 50;
const TITLE_CHARS = 80;
const TOOL_SOURCE_TITLES = 20;

export const isAcpMode = (value) => ACP_MODE_IDS.includes(value);

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

/** Serialize one message as a newline-terminated line. `JSON.stringify` escapes embedded newlines, so a frame is always one line. */
export const encodeAcpMessage = (message) => `${JSON.stringify(message)}\n`;

export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result: result ?? null });

export const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export const rpcNotification = (method, params) => ({ jsonrpc: '2.0', method, params });

/** A `session/update` notification carrying one update. */
export const sessionUpdate = (sessionId, update) => rpcNotification('session/update', { sessionId, update });

const isRpcId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

/**
 * Classify one received line.
 *
 * @returns {{ kind: 'request'|'notification'|'response'|'empty' } & object}
 *   `request` and `notification` carry `{ id?, method, params }`; `invalid`
 *   carries `{ id, error }` ready for `rpcError`; `response` is a reply to a
 *   request we sent (the adapter sends none, so it is ignored).
 */
export const parseAcpLine = (line) => {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!text) return { kind: 'empty' };
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return { kind: 'invalid', id: null, error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: 'Parse error' } };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return { kind: 'invalid', id: isRpcId(message?.id) ? message.id : null, error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Invalid request' } };
  }
  const hasId = Object.hasOwn(message, 'id');
  if (typeof message.method !== 'string') {
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return { kind: 'response', id: message.id };
    return { kind: 'invalid', id: isRpcId(message.id) ? message.id : null, error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Invalid request' } };
  }
  const params = message.params === undefined ? {} : message.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { kind: 'invalid', id: hasId && isRpcId(message.id) ? message.id : null, error: { code: JSON_RPC_ERRORS.INVALID_PARAMS, message: 'params must be an object' } };
  }
  if (!hasId) return { kind: 'notification', method: message.method, params };
  if (!isRpcId(message.id)) return { kind: 'invalid', id: null, error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Invalid request id' } };
  return { kind: 'request', id: message.id, method: message.method, params };
};

/**
 * Split a byte stream into lines. `onLine` gets each complete line (CR
 * stripped); `onOverflow` fires once when a line exceeds `maxBytes`, and that
 * line is discarded up to its terminating newline.
 */
export const createLineDecoder = ({ onLine, onOverflow, maxBytes = MAX_ACP_LINE_BYTES }) => {
  let buffer = '';
  let discarding = false;
  const emit = (line) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discarding) discarding = false;
        else emit(line);
        newline = buffer.indexOf('\n');
      }
      if (!discarding && Buffer.byteLength(buffer) > maxBytes) {
        discarding = true;
        buffer = '';
        onOverflow?.();
      } else if (discarding) {
        buffer = '';
      }
    },
    end() {
      if (!discarding && buffer) emit(buffer);
      buffer = '';
    },
  };
};

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

/**
 * Incremental SSE parser. `onEvent({ event, data })` fires per dispatched frame
 * with `data` JSON-decoded when it parses (else the raw string). Comment lines
 * (`: keep-alive`) and frames without data are skipped.
 */
export const createSseParser = (onEvent) => {
  let buffer = '';
  let event = '';
  let dataLines = [];
  const dispatch = () => {
    if (dataLines.length) {
      const raw = dataLines.join('\n');
      let data = raw;
      try { data = JSON.parse(raw); } catch { /* non-JSON data stays a string */ }
      onEvent({ event: event || 'message', data });
    }
    event = '';
    dataLines = [];
  };
  const field = (line) => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') event = value;
    else if (name === 'data') dataLines.push(value);
    return undefined;
  };
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        field(line.endsWith('\r') ? line.slice(0, -1) : line);
        newline = buffer.indexOf('\n');
      }
    },
    end() {
      if (buffer) field(buffer);
      buffer = '';
      dispatch();
    },
  };
};

// ---------------------------------------------------------------------------
// Capabilities, modes and prompts
// ---------------------------------------------------------------------------

/** The `initialize` result: no auth methods (the adapter uses PortOS's own loopback credential), text-only prompts, no client MCP servers. */
export const buildInitializeResult = ({ version }) => ({
  protocolVersion: ACP_PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: true },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: { list: {} },
  },
  authMethods: [],
  agentInfo: { name: 'portos', title: 'PortOS', version },
});

export const buildModeState = (currentModeId) => ({
  currentModeId,
  availableModes: ACP_SESSION_MODES.map(({ id, name, description }) => ({ id, name, description })),
});

export const buildConfigOptions = (currentModeId) => ([{
  id: 'mode',
  name: 'PortOS mode',
  description: 'Which PortOS backend answers this session.',
  category: 'mode',
  type: 'select',
  currentValue: currentModeId,
  options: ACP_SESSION_MODES.map(({ id, name, description }) => ({ value: id, name, description })),
}]);

/** The mode/config payload `session/new` and `session/load` return. */
export const buildSessionModePayload = (currentModeId) => ({
  modes: buildModeState(currentModeId),
  configOptions: buildConfigOptions(currentModeId),
});

/**
 * Flatten an ACP prompt (ContentBlock[]) into the text PortOS receives.
 *
 * Text blocks are joined verbatim. Embedded text resources are appended as
 * labeled sections and resource links as their URI, so the question the user
 * typed is never rewritten. Image, audio and binary blocks are not supported by
 * either backend (the adapter advertises that in `initialize`) and are
 * reported in `unsupported` so the caller can refuse rather than drop them.
 */
export const promptToText = (prompt) => {
  if (!Array.isArray(prompt)) return { text: '', unsupported: [] };
  const parts = [];
  const unsupported = [];
  for (const block of prompt) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      parts.push(`[${typeof block.name === 'string' && block.name ? block.name : block.uri}](${block.uri})`);
    } else if (block?.type === 'resource' && typeof block.resource?.text === 'string') {
      parts.push(`Context from ${block.resource.uri || 'the editor'}:\n${block.resource.text}`);
    } else {
      unsupported.push(typeof block?.type === 'string' ? block.type : 'unknown');
    }
  }
  return { text: parts.join('\n\n').trim(), unsupported };
};

const textContent = (text) => ({ type: 'text', text });

export const agentMessageChunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: textContent(text) });
export const agentThoughtChunk = (text) => ({ sessionUpdate: 'agent_thought_chunk', content: textContent(text) });
export const userMessageChunk = (text) => ({ sessionUpdate: 'user_message_chunk', content: textContent(text) });

// ---------------------------------------------------------------------------
// Ask Yourself SSE → ACP
// ---------------------------------------------------------------------------

/**
 * Translate one `/api/ask` SSE frame (`open`, `sources`, `delta`, `done`,
 * `error`) into ACP updates.
 *
 * @returns {{ updates: object[], conversationId?: string, terminal?: { stopReason: string } | { error: string } }}
 */
export const translateAskEvent = ({ event, data }, { toolCallId = 'ask-sources' } = {}) => {
  if (event === 'open') {
    return { updates: [], ...(typeof data?.conversationId === 'string' ? { conversationId: data.conversationId } : {}) };
  }
  if (event === 'sources') {
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    const titles = sources.slice(0, TOOL_SOURCE_TITLES)
      .map((source) => [source?.kind, source?.title].filter((part) => typeof part === 'string' && part).join(': '))
      .filter(Boolean);
    const more = sources.length > titles.length ? `\n…and ${sources.length - titles.length} more` : '';
    return {
      updates: [{
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `Retrieved ${sources.length} source${sources.length === 1 ? '' : 's'} from PortOS`,
        kind: 'search',
        status: 'completed',
        content: titles.length ? [{ type: 'content', content: textContent(`${titles.map((title) => `- ${title}`).join('\n')}${more}`) }] : [],
        rawOutput: { count: sources.length },
      }],
    };
  }
  if (event === 'delta') {
    return { updates: typeof data?.text === 'string' && data.text ? [agentMessageChunk(data.text)] : [] };
  }
  if (event === 'done') {
    return { updates: [], terminal: { stopReason: 'end_turn' }, ...(typeof data?.conversationId === 'string' ? { conversationId: data.conversationId } : {}) };
  }
  if (event === 'error') {
    return { updates: [], terminal: { error: typeof data?.error === 'string' && data.error ? data.error : 'Ask Yourself failed' } };
  }
  return { updates: [] };
};

/** Replay a stored Ask conversation as ACP history updates. */
export const askConversationUpdates = (conversation) => (Array.isArray(conversation?.turns) ? conversation.turns : [])
  .filter((turn) => typeof turn?.content === 'string' && turn.content)
  .map((turn) => (turn.role === 'user' ? userMessageChunk(turn.content) : agentMessageChunk(turn.content)));

// ---------------------------------------------------------------------------
// Persistent Mind events → ACP
// ---------------------------------------------------------------------------

// The supervisor ids a capability pair `tool-request:<id>` / `tool-result:<id>`;
// both halves map onto one ACP tool call.
const capabilityToolCallId = (capabilityId) => (typeof capabilityId === 'string'
  ? capabilityId.replace(/^tool-(request|result):/, '')
  : '');

const displayText = (event) => (typeof event?.data?.displayText === 'string' ? event.data.displayText : '');

/**
 * Translate one Persistent Mind trajectory event for the prompt waiting on
 * `messageId`.
 *
 * Events of other turns are ignored. The turn is bound by the `mind.wake` whose
 * `data.messageId` is ours; every later event of that `turnId` streams. The
 * turn ends at `mind.turn.completed` (end_turn), `mind.failed` (error) or
 * `mind.paused` (end_turn with a notice: the supervisor keeps the message and
 * retries it later on its own).
 *
 * @param {object} event - a trajectory envelope as `/api/cos/mind/stream` sends it
 * @param {{ messageId: string, turnId: string|null }} binding
 * @returns {{ updates: object[], turnId?: string, terminal?: { stopReason: string } | { error: string } }}
 */
export const translateMindEvent = (event, { messageId, turnId }) => {
  if (!event || typeof event.kind !== 'string') return { updates: [] };
  if (!turnId) {
    if (event.kind === 'mind.wake' && event.data?.messageId === messageId && typeof event.turnId === 'string') {
      return { updates: [agentThoughtChunk('The Persistent Mind picked up this message.\n')], turnId: event.turnId };
    }
    return { updates: [] };
  }
  if (event.turnId !== turnId) return { updates: [] };
  switch (event.kind) {
    case 'mind.thought': {
      const text = displayText(event);
      return { updates: text ? [agentThoughtChunk(`${text}\n`)] : [] };
    }
    case 'mind.reply': {
      const text = displayText(event);
      return { updates: text ? [agentMessageChunk(text)] : [] };
    }
    case 'mind.capability.request': {
      const tool = typeof event.data?.tool === 'string' ? event.data.tool : 'PortOS tool';
      return {
        updates: [{
          sessionUpdate: 'tool_call',
          toolCallId: capabilityToolCallId(event.data?.capabilityId) || event.eventId,
          title: displayText(event) || `Requested PortOS tool ${tool}`,
          kind: 'other',
          status: 'in_progress',
          rawInput: { tool },
        }],
      };
    }
    case 'mind.capability.result': {
      const tool = typeof event.data?.tool === 'string' ? event.data.tool : 'PortOS tool';
      return {
        updates: [{
          sessionUpdate: 'tool_call_update',
          toolCallId: capabilityToolCallId(event.data?.capabilityId) || event.eventId,
          status: event.data?.success === true ? 'completed' : 'failed',
          content: [{ type: 'content', content: textContent(displayText(event) || `${tool} finished`) }],
          rawOutput: { tool, success: event.data?.success === true },
        }],
      };
    }
    case 'mind.memory.created': {
      const text = displayText(event);
      return { updates: text ? [agentThoughtChunk(`Saved a memory: ${text}\n`)] : [] };
    }
    case 'mind.turn.completed':
      return { updates: [], terminal: { stopReason: 'end_turn' } };
    case 'mind.failed':
      return { updates: [], terminal: { error: typeof event.data?.error === 'string' && event.data.error ? event.data.error : 'The Persistent Mind turn failed' } };
    case 'mind.paused': {
      const reason = typeof event.data?.error === 'string' && event.data.error ? `: ${event.data.error}` : '';
      return {
        updates: [agentThoughtChunk(`The Persistent Mind paused this turn${reason}. PortOS keeps the message and resumes it on its own.\n`)],
        terminal: { stopReason: 'end_turn' },
      };
    }
    default:
      return { updates: [] };
  }
};

/** Replay the exchanges of one mind session from a trajectory page. */
export const mindHistoryUpdates = (events, messageIds) => {
  const ours = new Set(Array.isArray(messageIds) ? messageIds : []);
  const updates = [];
  for (const event of Array.isArray(events) ? events : []) {
    const text = displayText(event);
    if (!text) continue;
    if (event.kind === 'mind.message.accepted' && ours.has(event.data?.messageId)) updates.push(userMessageChunk(text));
    else if (event.kind === 'mind.reply' && ours.has(event.data?.replyToMessageId)) updates.push(agentMessageChunk(text));
  }
  return updates;
};

// ---------------------------------------------------------------------------
// Session records
// ---------------------------------------------------------------------------

/** A one-line title from the first prompt, for `session/list`. */
export const sessionTitle = (text) => {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
};

const isRecord = (value) => value && typeof value === 'object'
  && typeof value.sessionId === 'string' && isAcpMode(value.mode) && typeof value.updatedAt === 'string';

/** Normalize a parsed session file into a record list, dropping anything malformed. */
export const normalizeSessionRecords = (value) => (Array.isArray(value?.sessions) ? value.sessions : [])
  .filter(isRecord)
  .map((record) => ({
    sessionId: record.sessionId,
    mode: record.mode,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    title: typeof record.title === 'string' ? record.title : '',
    conversationId: typeof record.conversationId === 'string' ? record.conversationId : null,
    messageIds: Array.isArray(record.messageIds) ? record.messageIds.filter((id) => typeof id === 'string').slice(-MAX_ACP_SESSION_MESSAGE_IDS) : [],
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : record.updatedAt,
    updatedAt: record.updatedAt,
  }));

/** Replace or add one record, keeping the newest `max` by `updatedAt`. */
export const upsertSessionRecord = (records, record, max = MAX_ACP_SESSION_RECORDS) => [
  record,
  ...records.filter((existing) => existing.sessionId !== record.sessionId),
].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).slice(0, max);

/**
 * One `session/list` page, newest first, optionally narrowed to a working
 * directory. The cursor is the opaque offset of the next page.
 */
export const listSessionPage = (records, { cwd, cursor } = {}, pageSize = ACP_SESSION_LIST_PAGE_SIZE) => {
  const matching = typeof cwd === 'string' && cwd ? records.filter((record) => record.cwd === cwd) : records;
  const offset = typeof cursor === 'string' && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const page = matching.slice(offset, offset + pageSize);
  const next = offset + page.length;
  return {
    sessions: page.map((record) => ({
      sessionId: record.sessionId,
      cwd: record.cwd,
      title: record.title || null,
      updatedAt: record.updatedAt,
      _meta: { portos: { mode: record.mode } },
    })),
    ...(next < matching.length ? { nextCursor: String(next) } : {}),
  };
};

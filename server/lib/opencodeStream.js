/**
 * OpenCode's `--format json` event stream — one parser, shared.
 *
 * Two PortOS features drive an OpenCode agent and read its stdout: the runtime
 * agent-task benchmark (`services/localModelAgentBenchmark.js`, which wants
 * chars and token counts) and the capability test suite
 * (`services/modelCapabilityTests.js`, which wants a readable transcript). They
 * aggregate different things, but they are reading the SAME envelope — and that
 * envelope has already changed shape once upstream.
 *
 * So the envelope lives here and the aggregations live with their callers. A
 * second parser is how the two end up reporting different tool-call counts for
 * the same run, and how a future OpenCode change gets fixed in one file and
 * missed in the other.
 *
 * Pure: no I/O, no spawning. `services/opencodeTask.js` is the runner that
 * produces the stream this module reads.
 */

/**
 * OpenCode has used a flat `{type:'text', part:{text}}` envelope and a nested
 * `{type:'message.part.updated', properties:{part:{…}}}` one. Both are accepted;
 * anything else yields no part, and its frame renders as nothing rather than as
 * noise.
 */
export const eventPart = (event) => event?.part || event?.properties?.part || event?.data?.part || null;

/** Part types that mean "the agent called a tool", across envelope versions. */
export const TOOL_PART_TYPES = new Set(['tool', 'tool_use', 'tool-call']);

export const isToolEvent = (event) => TOOL_PART_TYPES.has(eventPart(event)?.type || event?.type)
  || event?.type === 'tool_use';

/** The assistant text a frame carries, or '' when it carries none. */
export function eventText(event) {
  const part = eventPart(event);
  if ((part?.type || event?.type) !== 'text') return '';
  const text = typeof part?.text === 'string' ? part.text : event?.text;
  return typeof text === 'string' ? text : '';
}

/** One stdout line → a parsed frame, or `null` for a blank or unparsable line. */
export function parseAgentLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

/** Every parsable frame in a whole stdout buffer, in order. */
export function parseAgentEvents(output) {
  return String(output || '').split(/\r?\n/).map(parseAgentLine).filter(Boolean);
}

const firstString = (...values) => values.find((v) => typeof v === 'string' && v.trim()) || '';

/**
 * Render one frame as a transcript line a person can read while the agent works.
 *
 * @returns {{ line: string, toolCall: boolean }|null} `null` for a frame with
 *   nothing worth showing — a heartbeat, an ack, an unknown envelope.
 */
export function formatAgentEvent(event) {
  const part = eventPart(event);
  const type = part?.type || event?.type;

  if (isToolEvent(event)) {
    const name = firstString(part?.tool, part?.name, event?.tool, event?.name) || 'tool';
    // The one detail worth showing beside a tool name is what it acted ON — a
    // path or a command. Everything else is argument noise at transcript width.
    const input = part?.input || part?.args || part?.state?.input || event?.input || {};
    const target = firstString(input.filePath, input.path, input.command);
    return { line: `● ${name}${target ? ` ${target}` : ''}`, toolCall: true };
  }

  if (type === 'text') {
    const text = eventText(event).trim();
    return text ? { line: text, toolCall: false } : null;
  }

  if (type === 'error' || event?.error) {
    const message = firstString(event?.error?.message, event?.error, part?.error, event?.message);
    return message ? { line: `✖ ${message}`, toolCall: false } : null;
  }

  return null;
}

/**
 * Task evidence from a whole stream: how much the assistant actually said, how
 * many tools it called, and the token counts OpenCode exposed.
 *
 * Tool ARGUMENTS are deliberately not counted as answer text — a benchmark that
 * counted them would reward a model for verbose tool calls.
 */
export function summarizeOpenCodeEvents(output) {
  let assistantText = '';
  let toolCalls = 0;
  let outputTokens = 0;
  let hasOutputTokens = false;

  for (const event of parseAgentEvents(output)) {
    assistantText += eventText(event);
    if (isToolEvent(event)) toolCalls += 1;

    const part = eventPart(event);
    const candidate = part?.tokens?.output ?? event?.tokens?.output
      ?? event?.usage?.completion_tokens ?? event?.usage?.output_tokens;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      outputTokens += candidate;
      hasOutputTokens = true;
    }
  }

  return {
    assistantChars: assistantText.length,
    toolCalls,
    // `null` = OpenCode reported no usage at all — NOT zero, which a reader
    // would take for a measured standstill.
    outputTokens: hasOutputTokens ? outputTokens : null,
  };
}

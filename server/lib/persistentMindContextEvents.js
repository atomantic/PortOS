/** Prompt projection only: diagnostics and raw evidence remain intact in the ledger. */
const CONTENT_KINDS = new Set([
  'mind.message.accepted', 'mind.annotation.accepted', 'mind.reply', 'mind.memory.created',
  'mind.capability.result', 'mind.thought',
]);

export function selectPersistentMindContextEvents(events, mindId = 'cos-persistent-mind') {
  const seenIds = new Set();
  const failedTurns = new Set((Array.isArray(events) ? events : [])
    .filter(event => event?.mindId === mindId && ['mind.failed', 'mind.paused'].includes(event.kind))
    .map(event => event.turnId).filter(Boolean));
  const ordered = (Array.isArray(events) ? events : []).filter(event => {
    if (event?.mindId !== mindId || !CONTENT_KINDS.has(event.kind)
      || !Number.isSafeInteger(event.sequence) || event.sequence < 0
      || typeof event.eventId !== 'string' || !event.eventId
      || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
      || event.at !== new Date(event.at).toISOString()
      || typeof event.data?.displayText !== 'string' || !event.data.displayText.trim()
      || event.data.duplicate === true) return false;
    if (['mind.reply', 'mind.thought'].includes(event.kind) && failedTurns.has(event.turnId)) return false;
    if (event.kind === 'mind.capability.result' && (event.data.success !== true
      || !((typeof event.data.tool === 'string' && event.data.tool.trim())
        || (typeof event.data.taskId === 'string' && event.data.taskId
          && typeof event.data.appId === 'string' && event.data.appId)))) return false;
    // Working notes are public summaries, never private model reasoning. Prefer
    // the final reply when one exists, to avoid two recaps of the same turn.
    if (event.kind === 'mind.thought' && (event.data.visibility !== 'user-summary'
      || !event.turnId || events.some(other => other?.mindId === mindId
        && other.turnId === event.turnId && other.kind === 'mind.reply'
        && typeof other.data?.displayText === 'string' && other.data.displayText.trim()))) return false;
    if (seenIds.has(event.eventId)) return false;
    seenIds.add(event.eventId);
    return true;
  }).sort((a, b) => a.sequence - b.sequence);
  // Repeated assistant/status prose should not evict a user's distinct inputs.
  // Retain the latest occurrence; human repetitions remain separate evidence.
  const seenContent = new Set();
  return ordered.reverse().filter(event => {
    if (['mind.message.accepted', 'mind.annotation.accepted'].includes(event.kind)) return true;
    const key = `${event.kind}:${event.data.displayText.trim().replace(/\s+/g, ' ')}`;
    if (seenContent.has(key)) return false;
    seenContent.add(key);
    return true;
  }).reverse();
}

export function renderPersistentMindContextEvent(event) {
  // Quoted text cannot forge headings or make historical evidence a new instruction.
  return `[${event.sequence}] [${event.at}] ${event.kind}: ${JSON.stringify(event.data.displayText.trim().slice(0, 8000))}`;
}

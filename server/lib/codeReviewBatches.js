import { createHash } from 'node:crypto';

// A conservative transport bound, not a claim about any model's token window.
// A file that cannot fit stays explicitly unreviewed; its contents are never cut.
export const CODE_REVIEW_BATCH_BYTES = 128 * 1024;
export const CODE_REVIEW_MAX_BATCHES = 64;

const digest = text => createHash('sha256').update(text).digest('hex');

/** Explicit vendor capacity refusals only; never infer an auth/config fault. */
export function isReviewContextCapacityFailure(result) {
  // Successful JSON verdicts may legitimately discuss context-capacity bugs.
  // Classify structured errors or plain vendor refusals, never their quoted text.
  const plain = value => typeof value === 'string' && !/^[\s]*[\[{`]/.test(value) ? value : null;
  const streamErrors = [];
  if (result?.streamFormat === 'stream-json' && typeof result.text === 'string') {
    for (const line of result.text.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event?.is_error || event?.type === 'error') streamErrors.push(event.error?.message, event.error, event.message, event.result);
      } catch { /* Incomplete stream lines cannot establish a capacity refusal. */ }
    }
  }
  return [...streamErrors, result?.error, result?.error?.message,
    result?.error || result?.partial ? result?.stderr : null,
    plain(result?.text), plain(result?.content)].some(value =>
    typeof value === 'string' && /prompt is too long|context[_ ](?:length[_ ]exceeded|window[_ ]exceeded)|maximum context length|exceeds? (?:the |your )?(?:model.s? )?(?:context|input) (?:window|limit|length)|input (?:is )?too (?:long|large)/i.test(value));
}

export const reviewContextCapacityFailure = () => ({
  ok: false,
  code: 'REVIEW_CONTEXT_CAPACITY',
  error: 'The selected reviewer refused the input because it exceeds its context capacity.',
});

/** Reserve one actual completion immediately before dispatch (including retries). */
export function takeCodeReviewCallBudget(budget, fallbackMs) {
  if (!budget) return fallbackMs;
  const remainingMs = budget.deadline - Date.now();
  if (remainingMs <= 0 || budget.calls >= budget.maxCalls) return null;
  budget.calls++;
  return remainingMs;
}

/** Keep byte-exact file sections, including quoted/renamed/binary headers.
 * Headers are opaque git file identifiers, not paths for filesystem access.
 * A non-git unified diff remains one indivisible section.
 */
function diffFiles(diff) {
  const starts = [...diff.matchAll(/^diff --git .+$/gm)].map(match => match.index);
  if (!starts.length) return [{ id: 0, file: null, diff, bytes: Buffer.byteLength(diff) }];
  return starts.map((start, id) => {
    const section = diff.slice(id === 0 ? 0 : start, starts[id + 1] ?? diff.length);
    return { id, file: diff.slice(start, diff.indexOf('\n', start) < 0 ? diff.length : diff.indexOf('\n', start)), diff: section, bytes: Buffer.byteLength(section) };
  });
}

/** One review round, with one shared wall-clock/call budget and immutable input.
 * runBatch MUST return a validated verdict; transport success is insufficient.
 * Optional/required policy and iteration limits remain with the caller.
 */
export async function runCodeReviewBatches({ diff, headSha = null, budgetMs, maxBatchBytes = CODE_REVIEW_BATCH_BYTES, maxBatches = CODE_REVIEW_MAX_BATCHES, startedAt = Date.now(), runBatch }) {
  const budget = { deadline: startedAt + budgetMs, budgetMs, calls: 0, maxCalls: maxBatches };
  const files = diffFiles(diff);
  const queue = [];
  for (const file of files) {
    const last = queue.at(-1);
    if (last && last.bytes + file.bytes <= maxBatchBytes) {
      last.files.push(file);
      last.bytes += file.bytes;
    } else queue.push({ files: [file], bytes: file.bytes });
  }
  const reviewed = new Set();
  const batches = [];
  const findings = [];
  let cleanFindings = 'No findings.';
  let failure = null;
  let identity = {};
  while (queue.length) {
    const batch = queue.shift();
    const remainingMs = budget.deadline - Date.now();
    if (remainingMs <= 0 || budget.calls >= maxBatches) {
      failure ||= { code: 'REVIEW_BUDGET_EXHAUSTED' };
      break;
    }
    if (batch.bytes > maxBatchBytes) {
      failure ||= reviewContextCapacityFailure();
      batches.push({ files: batch.files.map(file => file.id), outcome: 'context_capacity', attempted: false });
      continue;
    }
    const input = batch.files.map(file => file.diff).join('');
    const result = await Promise.resolve().then(() => runBatch(input, remainingMs, budget))
      .catch(() => ({ ok: false, code: 'REVIEW_BATCH_FAILED', error: 'A review batch failed before returning a verdict; review coverage is incomplete.' }));
    identity = { ...identity, ...Object.fromEntries(['backend', 'model', 'effort', 'effortUnsupported'].filter(key => result[key] !== undefined).map(key => [key, result[key]])) };
    const capacity = isReviewContextCapacityFailure(result) || result.code === 'REVIEW_CONTEXT_CAPACITY';
    batches.push({ files: batch.files.map(file => file.id), diffSha256: digest(input), outcome: result.ok ? result.verdict : capacity ? 'context_capacity' : 'inconclusive', attempted: true });
    if (capacity && batch.files.length > 1) {
      const middle = Math.ceil(batch.files.length / 2);
      queue.unshift(...[batch.files.slice(0, middle), batch.files.slice(middle)].map(parts => ({ files: parts, bytes: parts.reduce((sum, file) => sum + file.bytes, 0) })));
      continue;
    }
    if (!result.ok) {
      failure ||= capacity ? reviewContextCapacityFailure() : { code: result.code || 'REVIEW_BATCH_FAILED', error: result.error, diagnostics: result.diagnostics };
      // An input-specific capacity refusal does not prevent reviewing other files.
      // Other failures stop spending, preserving any earlier actionable findings.
      if (!capacity) break;
      continue;
    }
    for (const file of batch.files) reviewed.add(file.id);
    if (result.verdict === 'findings') findings.push(result.findings);
    else cleanFindings = result.findings;
  }
  const complete = reviewed.size === files.length;
  const coverage = {
    headSha, diffSha256: digest(diff), complete,
    files: files.map(({ id, file, bytes }) => ({ id, file, bytes })),
    reviewedFiles: [...reviewed], remainingFiles: files.filter(file => !reviewed.has(file.id)).map(file => file.id),
    batches, calls: budget.calls, maxBatches, budgetMs,
  };
  return {
    ...identity, ok: complete, coverage,
    ...(findings.length ? { verdict: 'findings', findings: findings.join('\n\n') } : complete ? { verdict: 'clean', findings: cleanFindings } : {}),
    ...(!complete ? {
      code: failure?.code || 'REVIEW_INCOMPLETE',
      ...(failure?.diagnostics ? { diagnostics: failure.diagnostics } : {}),
      error: failure?.code === 'REVIEW_CONTEXT_CAPACITY'
        ? 'The selected reviewer could not cover every file within its context capacity; review coverage is incomplete.'
        : failure?.code === 'REVIEW_BUDGET_EXHAUSTED'
          ? failure?.error || 'The configured review budget ended before every file received a verdict; review coverage is incomplete.'
          : failure?.error || 'A review batch returned no usable verdict; review coverage is incomplete.',
    } : {}),
  };
}

/** Bounded, local-only video failure summaries shared by the runner and queue. */
import { createHash } from 'crypto';
import { scrubSecretTokens } from './secretText.js';

const MAX_TAIL_BYTES = 8192;
const MAX_CAUSE_LENGTH = 240;
const failureRecord = (classification, cause, identity = cause) => ({
  classification,
  cause,
  // Streak-only evidence. Never projected or persisted in an active hold. Keep
  // diagnostic identifiers distinct even when the display redacts quotes.
  signature: createHash('sha256').update(`${classification}\n${identity}`).digest('hex'),
});

const scrubCause = (text) => scrubSecretTokens(text)
  .replace(/\b(?:https?|file):\/\/\S+/gi, '[url]')
  .replace(/\b(?:proxy-)?authorization["']?\s*[:=][^\r\n]*/gi, '[credential]')
  .replace(/\b(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, '[credential]')
  // An unquoted path has no reliable ending delimiter (spaces are legal on
  // both platforms). Redact the remainder rather than leaking path fragments.
  .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?=\S))[^\r\n]*/g, '[path]')
  .replace(/\bprompt\b.*$/i, '[prompt]')
  .replace(/\b0x[\da-f]+\b/gi, '[address]')
  .replace(/\s+/g, ' ').trim();

// Only diagnostic-shaped lines or a producer's explicit error code qualify.
// Progress, prompts, signal advice and bare exit codes are not cause evidence.
export function normalizeVideoFailure(error, { prompts = [], code = error?.code } = {}) {
  let text = typeof error === 'string' ? error : error?.message;
  if (typeof text !== 'string') return null;
  for (const prompt of prompts.filter((p) => typeof p === 'string' && p)) text = text.replaceAll(prompt, '[prompt]');
  text = text.slice(-MAX_TAIL_BYTES).replace(/\x1b\[[0-9;]*m/g, '');
  if (/^(?:Generation failed:\s*)?Exit code \d+\s*$/i.test(text.trim())) return null;
  const missing = text.match(/(?:No module named|Python module) ['"]([\w.]+)['"]/);
  if (missing && scrubSecretTokens(missing[1]) === missing[1]) {
    return failureRecord('missing-module', `Python module ${missing[1].slice(0, 128)} is missing`);
  }
  if (/\b(?:CUDA|Metal|MPS|GPU).*out of memory|out of memory.*\b(?:CUDA|Metal|MPS|GPU)|GPU memory exhausted/i.test(text)) {
    return failureRecord('out-of-memory', 'GPU memory exhausted');
  }
  if (/watchdog timeout: no runner output/.test(text)) {
    return failureRecord('idle-timeout', 'Video runtime stopped reporting progress');
  }
  if (/\b(?:ENOENT|EACCES)\b/.test(text) && /spawn/i.test(text)) {
    return failureRecord('runtime-launch', `Video runtime could not start (${text.match(/\b(ENOENT|EACCES)\b/)[1]})`);
  }
  if (/python.*not configured/i.test(text)) {
    return failureRecord('runtime-configuration', 'Python runtime is not configured');
  }
  const exception = text.match(/(?:^|\n|Exit code \d+:\s*|runJob threw:\s*)([\w.]*?(?:Error|Exception)):\s*([^\r\n]+)/);
  const classification = exception?.[1] || (/^[A-Z][A-Z0-9_]{0,127}$/.test(code || '') ? code : null);
  if (!classification || scrubSecretTokens(classification) !== classification) return null;
  const identity = scrubCause(exception?.[2] || text);
  if (!/[a-z0-9]/i.test(identity.replace(/\[[^\]]*\]/g, ''))) return null;
  const display = identity.replace(/(['"])(?:\\.|(?!\1).)*?\1/g, '[value]').slice(0, MAX_CAUSE_LENGTH);
  const cause = /[a-z]{3}/i.test(display.replace(/\[[^\]]*\]/g, ''))
    ? display : `${classification}: redacted diagnostic details`;
  return failureRecord(classification.toLowerCase().slice(0, 128), cause, identity);
}

export function createVideoDiagnosticTail() {
  const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  return {
    push(stream, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      tails[stream] = Buffer.concat([tails[stream], bytes.subarray(-MAX_TAIL_BYTES)]).subarray(-MAX_TAIL_BYTES);
    },
    failure(options) {
      // Prefer stderr; some runtimes only write exceptions to stdout. Signal
      // classification comes from actual child evidence, never fallback advice.
      for (const stream of ['stderr', 'stdout']) {
        const lines = tails[stream].toString('utf8').split(/[\r\n]+/).slice(-40).reverse();
        for (const raw of lines) {
          let line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          for (const prompt of (options?.prompts || []).filter((p) => typeof p === 'string' && p)) line = line.replaceAll(prompt, '[prompt]');
          if (/^(?:prompt|STATUS|STAGE|DOWNLOAD|RUNTIME):/i.test(line) || line.startsWith('{')) continue;
          const metal = line.match(/kIOGPUCommandBufferCallbackError(OutOfMemory|InnocentVictim|Timeout|ImpactingInteractivity)\b/);
          if (stream === 'stderr' && metal) return failureRecord('metal-command-buffer', `Metal command buffer failed: ${metal[1]}`);
          if (!/^(?:[\w.]*?(?:Error|Exception)):\s/.test(line)) continue;
          const failure = normalizeVideoFailure(line, options);
          if (failure) {
            const prefix = `${line.split(':')[0].slice(0, 128)}:`;
            return { ...failure, summary: failure.cause.startsWith(prefix) ? failure.cause : `${prefix} ${failure.cause}` };
          }
        }
      }
      return null;
    },
  };
}

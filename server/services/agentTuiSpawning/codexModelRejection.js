// A Codex screen is arbitrary agent output until terminal chrome corroborates
// it. Keep this separate from the one-shot immediate-fallback detector: a tool
// can legitimately print an error fixture while its agent is still working.
const BUFFER_CAP = 4096;
const SETTLE_MS = 5000;
const ERROR_PREFIX = /(?:^|[\r\n])[ \t]*■\s*Unexpected\s*status\s*400\s*Bad\s*Request\s*:\s*/i;
const IDLE_COMPOSER = /(?:^|[\r\n])[ \t]*›[ \t]*Ask\s*Codex[^\r\n]*[\r\n]/i;
const WORKING = /esc\s*to\s*interrupt|(?:^|[\r\n])[ \t]*[•●]\s*(?:Working|Thinking|Running|Reconnecting)\b/i;

export function createCodexModelRejectionGate() {
  let buffer = '';
  let pending = null;

  return {
    observe(chunk) {
      if (!chunk) return;
      const next = buffer + chunk;
      // Do not manufacture a line start at a rolling-window slice boundary.
      buffer = next.length > BUFFER_CAP
        ? next.slice(-BUFFER_CAP).replace(/^[^\r\n]*/, '')
        : next;
      pending = null;
      const prefix = ERROR_PREFIX.exec(buffer);
      if (!prefix) return;
      const afterPrefix = buffer.slice(prefix.index + prefix[0].length);
      // The known envelope has an error object inside the response object.
      // Parse it instead of treating keywords in prose as a structured error.
      const envelope = /^(\{[\s\S]*?\}\s*\})/.exec(afterPrefix);
      if (!envelope) return;
      let response;
      try {
        // Codex hard-wraps JSON even inside strings when rendering the screen.
        response = JSON.parse(envelope[1].replace(/[\r\n]/g, ''));
      } catch {
        return;
      }
      if (response?.error?.type !== 'invalid_request_error'
        || typeof response.error.message !== 'string'
        || !/model\s*is\s*not\s*supported\s*when\s*using\s*Codex\s*with\s*a\s*ChatGPT\s*account/i.test(response.error.message)) return;

      const afterError = afterPrefix.slice(envelope[0].length);
      const composer = IDLE_COMPOSER.exec(afterError);
      // Codex on_error finalizes its turn BEFORE adding the ■ error cell. The
      // Worked-for separator is conditional on work, so a rejected first request
      // need not have it. The error cell is our turn-end evidence; demand a FRESH
      // empty composer after it, and invalidate on any later work.
      if (!composer || WORKING.test(afterError)) return;
      const beforeComposer = afterError.slice(0, composer.index);
      if (beforeComposer.split(/[\r\n]/).some(line => line.trim()
        && !/^[ \t]*[─━]+\s*Worked\s*for\s+[^\r\n]+$/i.test(line))) return;
      const afterComposer = afterError.slice(composer.index + composer[0].length);
      // Only footer chrome may follow: subsequent tool/assistant output makes
      // this a quoted fixture or a recovered session, never a terminal verdict.
      if (afterComposer.split(/[\r\n]/).some(line => line.trim()
        && !/^[ \t]*(?:\?\s*for\s*shortcuts|\d+%\s*context\s*left|[─━]+)[^\r\n]*$/i.test(line))) return;
      pending = {
        category: 'model-not-supported',
        actionable: true,
        origin: 'provider',
        message: 'Codex rejected the selected model for the signed-in ChatGPT account.',
        suggestedFix: 'Choose a model supported by the signed-in Codex account, or clear the model override to use the CLI default. API-key authentication uses separate API billing.',
        escalation: 'Pick a model the provider account supports (or clear the override to use the CLI default), then approve the retry.',
      };
    },
    takeRejected(now, lastOutputAt) {
      if (!pending || now - lastOutputAt < SETTLE_MS) return null;
      const result = pending;
      pending = null;
      buffer = '';
      return result;
    },
  };
}

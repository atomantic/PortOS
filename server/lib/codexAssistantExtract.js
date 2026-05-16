// Codex CLI echoes its full session transcript (banner + metadata + echoed
// prompt + `\ncodex\n<reply>` + token footer). JSON stages survive because the
// parser skips non-JSON chunks; text stages don't, so this helper carves out
// just the assistant reply. Idempotent for non-Codex output.
export function extractCodexAssistant(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!text.startsWith('OpenAI Codex v')) return text;

  const codexIdx = text.indexOf('\ncodex\n');
  if (codexIdx < 0) return text;
  let response = text.slice(codexIdx + '\ncodex\n'.length);

  const tokensIdx = response.lastIndexOf('\ntokens used');
  if (tokensIdx > 0) response = response.slice(0, tokensIdx);

  return response.trim();
}

const RE_CODEX_MARKERS = /(^|\n)(tokens used|apply patch|patch: completed)\b/;
const RE_TOKENS_USED_LINE = /^tokens used\b/;
const RE_NUMERIC_LINE = /^[\d,.\s]+$/;

// Newer Codex CLI streams the FINAL assistant message AFTER a `tokens used\n<count>`
// footer (rather than before, as `extractCodexAssistant` above assumes). The
// transcript also intersperses `exec` / `apply patch` / `codex` sections with raw
// diff and grep output that has no tool-marker prefix, so the generic backwards
// walk in `extractFinalSummary` cannot find the boundary on its own. Returns null
// for non-Codex input so callers fall through to the generic logic.
export function extractCodexAssistantTail(outputBuffer) {
  if (typeof outputBuffer !== 'string' || !outputBuffer) return null;
  if (!RE_CODEX_MARKERS.test(outputBuffer)) return null;

  const lines = outputBuffer.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!RE_TOKENS_USED_LINE.test(lines[i].trim())) continue;
    let j = i + 1;
    while (j < lines.length && RE_NUMERIC_LINE.test(lines[j].trim())) j++;
    const tail = lines.slice(j).join('\n').trim();
    if (tail) return tail;
  }
  return null;
}

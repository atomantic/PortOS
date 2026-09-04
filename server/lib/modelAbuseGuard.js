import { createHash } from 'node:crypto';

/**
 * Static contract for PortOS's model-abuse boundary.
 *
 * This is intentionally not part of the local chat-model catalog. Prompt Guard
 * is a dedicated text classifier: it is installed from one pinned Hugging Face
 * revision and executed by a separate offline Python runner. It is never sent
 * a PortOS tool definition and it is never selected as a normal chat provider.
 */

export const MODEL_ABUSE_GUARD_ID = 'llama-prompt-guard-2-86m';

export const MODEL_ABUSE_GUARD = Object.freeze({
  id: MODEL_ABUSE_GUARD_ID,
  name: 'Llama Prompt Guard 2 86M',
  repository: 'meta-llama/Llama-Prompt-Guard-2-86M',
  revision: 'a8ded8e697ce7c355e395a0df51f94adb4a2fd27',
  pipelineTag: 'text-classification',
  runtime: 'python-transformers',
  params: '86M',
  contextTokens: 512,
  gated: true,
  capabilities: ['classification', 'prompt-injection-detection'],
  sourceUrl: 'https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M',
  featured: {
    label: 'Recommended for model-abuse scanning',
    description: 'Dedicated local classifier with no chat, agent, tool, or MCP loop.'
  }
});

// Only these files are downloaded. The scanner never executes arbitrary
// repository Python or accepts a model directory from a request.
export const MODEL_ABUSE_GUARD_REQUIRED_FILES = Object.freeze([
  'config.json',
  'model.safetensors',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json'
]);

// The public-review model must be a text model with an explicit capability
// report and no native tool-calling capability. Keep this vocabulary here so
// the execution-time gate and its tests do not reimplement the policy beside
// the classifier contract.
export const MODEL_ABUSE_GUARD_TEXT_CAPABILITIES = Object.freeze(['chat', 'completion']);

/**
 * Fail-closed capability check for the downstream code-review model.
 *
 * An absent or empty capability list means "not measured", not "safe". The
 * caller must supply the backend's authoritative vocabulary (`chat` for
 * normalized catalog rows or `completion` from Ollama `/api/show`).
 */
export function hasToolFreeTextCapability(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return false;
  const normalized = capabilities.map((capability) => String(capability).toLowerCase());
  return normalized.some((capability) => MODEL_ABUSE_GUARD_TEXT_CAPABILITIES.includes(capability))
    && !normalized.includes('tools');
}

// These are fixed package import names, not user-controlled pip arguments.
export const MODEL_ABUSE_GUARD_PYTHON_IMPORTS = Object.freeze([
  'torch',
  'transformers',
  'safetensors',
  'huggingface_hub'
]);

// Operator-facing install stages, in the order `installModelAbuseGuard` runs
// them. Status maps host facts onto this list; the UI must not invent a
// parallel checklist. Token presence is a boolean on the stage — never a token
// value, path, or exception string.
export const MODEL_ABUSE_GUARD_STAGES = Object.freeze([
  {
    id: 'huggingface-token',
    label: 'Hugging Face access token',
    description: 'A read token plus gated-model approval on the Prompt Guard model card.',
  },
  {
    id: 'python',
    label: 'Host Python',
    description: 'A Python interpreter PortOS can use as the base for the dedicated runtime.',
  },
  {
    id: 'venv',
    label: 'Dedicated Prompt Guard runtime',
    description: 'A private virtualenv that never shares packages with image or video generation.',
  },
  {
    id: 'packages',
    label: 'Classifier packages',
    description: 'Pinned torch, transformers, safetensors, and huggingface_hub imports.',
  },
  {
    id: 'model',
    label: 'Pinned model snapshot',
    description: 'The five required Prompt Guard files from the pinned revision.',
  },
]);

/**
 * Map host facts onto the fixed install-stage list.
 *
 * `ready` on the envelope is the scan-time gate (cached weights + importable
 * runtime). Token/Python/venv are prerequisites the installer still has to
 * clear; they do not by themselves make the classifier usable.
 */
export function modelAbuseGuardStageReadiness({
  huggingfaceTokenPresent = false,
  pythonAvailable = false,
  venvReady = false,
  runtimeReady = false,
  modelCached = false,
} = {}) {
  const readyById = {
    'huggingface-token': huggingfaceTokenPresent === true,
    python: pythonAvailable === true,
    venv: venvReady === true,
    packages: runtimeReady === true,
    model: modelCached === true,
  };
  return {
    stages: MODEL_ABUSE_GUARD_STAGES.map((stage) => ({
      ...stage,
      ready: readyById[stage.id] === true,
    })),
    ready: runtimeReady === true && modelCached === true,
  };
}

// Read the complete supplied item up to this bound. Never truncate and then
// treat the prefix as a trustworthy verdict.
export const MODEL_ABUSE_GUARD_MAX_INPUT_CHARS = 2_000_000;
// Compact chunk metadata is still proportional to the number of windows. Keep
// the bound above the worst case for a complete 2M-character scan so a valid
// long input cannot be mistaken for a failed/partial verdict.
export const MODEL_ABUSE_GUARD_MAX_OUTPUT_CHARS = 2_000_000;
export const MODEL_ABUSE_GUARD_MAX_CHUNKS = 100_000;
export const MODEL_ABUSE_GUARD_MIN_BENIGN_SCORE = 0.9;
export const MODEL_ABUSE_GUARD_TIMEOUT_MS = 5 * 60 * 1000;
export const MODEL_ABUSE_GUARD_CHUNK_TOKENS = 512;
export const MODEL_ABUSE_GUARD_CHUNK_OVERLAP = 64;

/**
 * Serialize cleared public-review material for the no-tools code-review
 * stage. The JSON is supplied as data in the user message; it is not a path
 * for the reviewer to resolve and it never includes flagged PRs.
 */
export function formatPublicReviewInputPrompt(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  // Keep attacker-controlled strings inside the data envelope even when they
  // contain the literal closing delimiter. JSON parsing still reconstructs the
  // original values, while the model cannot mistake a value for framing.
  const serialized = JSON.stringify(snapshot)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
  return [
    '<cleared-public-review-input>',
    serialized,
    '</cleared-public-review-input>',
  ].join('\n');
}

/**
 * Whether a value is a sha256 hex digest — the shape every fingerprint field
 * on this boundary takes (content fingerprints, scan keys, intent
 * fingerprints), so a validator cannot drift from what the hashes above emit.
 */
export const isSha256Hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

/**
 * Fingerprint the exact public content that crossed the abuse boundary. This
 * belongs beside the scanner contract so every caller uses the same identity
 * and cannot accidentally downgrade freshness to a commit-SHA-only check.
 */
export function modelAbuseContentFingerprint(kind, identity, content) {
  if (
    typeof kind !== 'string' || !kind
    || !identity || typeof identity !== 'object' || Array.isArray(identity)
    || typeof content !== 'string'
  ) return null;
  return createHash('sha256')
    .update(JSON.stringify({ kind, ...identity }))
    .update('\u0000')
    .update(content)
    .digest('hex');
}

const isIssueNumber = (value) => Number.isInteger(value) && value > 0 && value <= 1_000_000;

const normalizeIssueNumbers = (value) => Array.isArray(value)
  ? [...new Set(value.filter(isIssueNumber))]
    .sort((a, b) => a - b)
    .slice(0, 50)
  : [];

// The filed issue's own text is what "does this PR do what was asked?" is
// judged against, so it is bounded the way every other public input is: a
// linked-issue list is evidence, never a channel for unbounded contributor
// prose.
export const LINKED_ISSUE_MAX_COUNT = 10;
export const LINKED_ISSUE_TITLE_MAX_CHARS = 300;
export const LINKED_ISSUE_BODY_MAX_CHARS = 8_000;

/**
 * The intent evidence for one PR: the open issues it links, reduced to number,
 * title, and description. `truncated` is carried per issue so a reviewer can
 * tell a complete requirement from a clipped one rather than judging a diff
 * against half a sentence.
 */
export function normalizeLinkedIssues(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const issues = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const { number } = raw;
    if (!isIssueNumber(number) || seen.has(number)) continue;
    const title = typeof raw.title === 'string' ? raw.title : '';
    const body = typeof raw.body === 'string' ? raw.body : '';
    seen.add(number);
    issues.push({
      number,
      title: title.slice(0, LINKED_ISSUE_TITLE_MAX_CHARS),
      body: body.slice(0, LINKED_ISSUE_BODY_MAX_CHARS),
      truncated: title.length > LINKED_ISSUE_TITLE_MAX_CHARS || body.length > LINKED_ISSUE_BODY_MAX_CHARS,
    });
  }
  return issues.sort((a, b) => a.number - b.number).slice(0, LINKED_ISSUE_MAX_COUNT);
}

/**
 * The exact linked-issue text that crosses the model-abuse boundary. Composed
 * from the NORMALIZED list so the scanned string, the fingerprint, and the
 * envelope a reviewer reads are the same bytes.
 */
export function linkedIssueIntentContent(issues) {
  return normalizeLinkedIssues(issues).map((issue) => [
    `Linked issue #${issue.number} title:`,
    issue.title,
    `Linked issue #${issue.number} description:`,
    issue.body,
  ].join('\n\n')).join('\n\n');
}

/**
 * Stable identity for a PR's screened intent evidence. A linked issue that is
 * closed, retitled, rewritten, or swapped after the gate judged the change
 * produces a different value, so an old allowlist cannot survive an intent it
 * was never evaluated against. `null` means there is no intent evidence at
 * all — never treat that as a match.
 */
export function linkedIssueIntentFingerprint(issues) {
  const normalized = normalizeLinkedIssues(issues);
  const content = linkedIssueIntentContent(normalized);
  if (!content) return null;
  return modelAbuseContentFingerprint('linked-issue-intent', {
    numbers: normalized.map((issue) => issue.number),
  }, content);
}

/**
 * The server-established facts the Eligibility Gate may rely on, in one
 * validated shape. Unknown is deliberately false: a missing facts object is
 * not approval. `maintainerTargeted` is set only by the pr-reviewer preflight
 * for a per-PR "Review this PR" request and waives the linked-issue
 * prerequisite; it is never inferred from PR text. `intentFingerprint` pins the
 * screened issue text the gate judged the diff against.
 */
export function normalizeEligibilityFacts(value) {
  const facts = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    linkedIssueNumbers: normalizeIssueNumbers(facts.linkedIssueNumbers),
    openLinkedIssueNumbers: normalizeIssueNumbers(facts.openLinkedIssueNumbers),
    openerAssignedIssueNumbers: normalizeIssueNumbers(facts.openerAssignedIssueNumbers),
    issueLookupComplete: facts.issueLookupComplete === true,
    maintainerTargeted: facts.maintainerTargeted === true,
    intentFingerprint: isSha256Hex(facts.intentFingerprint) ? facts.intentFingerprint.toLowerCase() : null,
  };
}

/**
 * Whether the linked-open-issue prerequisite is waived for this PR. The
 * server sets `maintainerTargeted` only for an explicit "Review this PR"
 * request: that prerequisite bounds UNATTENDED spend on unsolicited PRs, and
 * the request is the maintainer spending it. Both the eligibility gate and the
 * pre-action recheck read the waiver from here so they cannot disagree.
 */
export function issuePrerequisiteWaived(facts) {
  return normalizeEligibilityFacts(facts).maintainerTargeted;
}

const blockingFinding = (category, reason) => ({
  severity: 'blocking',
  category,
  location: 'external-content',
  reason
});

// Words that address a downstream model or reviewer. Several checks below
// require one of these NEAR the suspicious phrase, so ordinary application
// text about agents, prompts, or payloads (this codebase is full of it) is
// not itself a finding.
const MODEL_TARGET_RE = /\b(?:agents?|assistants?|models?|llms?|ai|claude|codex|copilot|gemini|gpt|grok|reviewers?|bots?)\b/i;

/**
 * Code points that render as nothing, reorder what a human sees, or smuggle
 * ASCII inside otherwise-invisible characters — a contributor cannot type these
 * by accident, and every one of them reaches a model's tokenizer:
 * zero-width spaces/joiners and bidi marks (U+200B–U+200F), bidi embedding /
 * override controls (U+202A–U+202E, U+2066–U+2069 — "Trojan Source"), word
 * joiner and invisible operators (U+2060–U+2064), line/paragraph separators
 * (U+2028, U+2029), the BOM as a mid-text character (U+FEFF), Mongolian vowel
 * separator and Hangul fillers (U+180E, U+115F, U+1160, U+3164, U+FFA0), the
 * Unicode tag block used for ASCII smuggling (U+E0000–U+E007F), and the
 * variation-selector supplement (U+E0100–U+E01EF).
 */
const HIDDEN_CODEPOINT_RE = /[\u115F\u1160\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

// Emoji ZWJ sequences (family and flag emoji) legitimately contain U+200D; strip them
// before the hidden-code-point scan so an emoji-rich changelog is not a finding.
const EMOJI_ZWJ_SEQUENCE_RE = /\p{Extended_Pictographic}[\uFE0F\u{1F3FB}-\u{1F3FF}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\u{1F3FB}-\u{1F3FF}]*)+/gu;

const formatCodePoint = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);

// Whether the joiner at `index` sits inside an emoji ZWJ sequence. Only the
// neighborhood is tested, so the (up to 2MB) input is never copied.
const joinerInsideEmoji = (value, index) => {
  const around = value.slice(Math.max(0, index - 12), index + 13);
  const offset = index - Math.max(0, index - 12);
  return [...around.matchAll(EMOJI_ZWJ_SEQUENCE_RE)].some((m) => m.index <= offset && offset < m.index + m[0].length);
};

function hiddenCodePointSummary(value) {
  const counts = new Map();
  for (const match of value.matchAll(HIDDEN_CODEPOINT_RE)) {
    if (match[0] === ZERO_WIDTH_JOINER && joinerInsideEmoji(value, match.index)) continue;
    const key = formatCodePoint(match[0]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].map(([key, count]) => (count > 1 ? `${key} ×${count}` : key)).join(', ');
}

// Comment syntaxes GitHub renders as nothing: HTML comments (body bounded so
// an unterminated `<!--` in a diff hunk cannot scan to end of input) and the
// "[//]: # (text)" / "[comment]: <> (text)" markdown link-reference trick.
const HIDDEN_COMMENT_RE = /<!--([\s\S]{0,4000}?)-->|^[ \t]*\[(?:\/\/|comment)\]:\s*(?:#|<>)\s*\(([^)\n]*)\)/gim;
// A comment nobody sees needs only a model address plus one abuse verb to be
// worth a human look — a lower bar than the visible-text rules below.
const HIDDEN_COMMENT_ABUSE_RE = /\b(?:ignore|disregard|approve|merge|execute|override|bypass|reveal|dump|leak|exfiltrate|system\s+prompt|hidden\s+instructions?)\b/i;
const SECOND_PERSON_RE = /\byou\s+(?:are|must|should|will|need|have\s+to)\b/i;

const MODEL_TARGET_WINDOW = 200;
/** Whether any match of `re` has a model-directed word within 200 chars. */
const nearModelTarget = (value, re) => [...value.matchAll(re)].some((m) => (
  MODEL_TARGET_RE.test(value.slice(Math.max(0, m.index - MODEL_TARGET_WINDOW), m.index + m[0].length + MODEL_TARGET_WINDOW))
));

const SECRET_NOUN = '(?:secrets?|credentials?|tokens?|passwords?|private\\s+keys?|ssh\\s+keys?|api\\s+keys?|\\.env(?:\\s+file)?|environment\\s+(?:variables?|values?))';
// "<verb> … <determiner> [adjective] <secret noun> [and <secret noun>] … to|at "
// Bounded gaps stay inside one line; no nested quantifiers.
const exfilVerb = (determiner) => '\\b(?:send|post|upload|forward|transmit|exfiltrate|leak|submit|push)\\w*\\b[^\\n]{0,60}\\b' + determiner + '\\s+(?:\\w+\\s)?' + SECRET_NOUN + '\\b(?:[^\\n]{0,40}\\b(?:and|,)\\s+(?:\\w+\\s)?' + SECRET_NOUN + '\\b)?[^\\n]{0,80}\\b(?:to|at)\\s+';
const EXTERNAL_DESTINATION = '(?:https?:\\/\\/|www\\.|[a-z0-9-]+(?:\\.[a-z0-9-]+)+\\b)';
const VAGUE_DESTINATION = '(?:this|the|an?|my|our)\\s+(?:\\w+\\s){0,2}(?:url|endpoint|address|webhook|server|host|bucket|gist|pastebin)\\b';

/**
 * The visible-text rules, as data. `patterns` run whole-document; a row with
 * `nearModelTarget` additionally requires a model-directed word within 200
 * chars of the match, which is how a phrase that is also ordinary prose about
 * this app ("approve automatically", "send the credential to the server") is
 * held to a model-addressed shape. Every bounded gap is a single line.
 */
const VISIBLE_TEXT_RULES = [
  {
    category: 'instruction-override',
    reason: 'Content attempts to override or replace instructions used by a downstream model.',
    patterns: [
      /\b(?:ignore|disregard|forget|override|bypass|disobey)\s+(?:(?:all|any|the|your|every|of\s+your|my)\s+(?:(?:previous|prior|above|earlier|preceding|original|initial|system|developer|reviewer|safety|security)\s+){0,2}|(?:(?:previous|prior|above|earlier|preceding|original|initial|system|developer|reviewer|safety|security)\s+){1,2})(?:instructions?|rules?|prompts?|guidelines?|directives?|guardrails?|constraints?|polic(?:y|ies))\b/i,
      /\b(?:system|developer)\s+(?:prompt|instructions?)\b[^\n]{0,60}\b(?:ignore|override|replace|bypass|disregard)\b/i,
      /\byou\s+are\s+(?:now|no\s+longer)\s+(?:an?\s+|the\s+)?(?:\w+\s+){0,3}?(?:agent|assistant|model|reviewer|ai|bot|dan)\b/i,
    ],
  },
  {
    category: 'context-disclosure',
    reason: 'Content attempts to extract private prompts, context, credentials, or local data from a downstream model.',
    patterns: [
      /\b(?:reveal|print|dump|show|disclose|leak|repeat|quote|output|display|echo)\w*\b[^\n]{0,60}\b(?:your\s+)?(?:system\s+prompt|developer\s+prompt|hidden\s+instructions?|initial\s+instructions?|original\s+instructions?|internal\s+instructions?)\b/i,
      /\b(?:reveal|print|dump|show|disclose|leak|output|display|echo|exfiltrate)\w*\b[^\n]{0,40}\byour\s+(?:secrets?|credentials?|api\s+keys?|tokens?|passwords?|private\s+keys?|environment\s+variables?|\.env|ssh\s+keys?|context|memory)\b/i,
      /\b(?:reveal|dump|disclose|leak|exfiltrate)\w*\b[^\n]{0,40}\b(?:the\s+)?(?:\.env(?:\s+file)?|environment\s+variables?|ssh\s+keys?|private\s+keys?)\b/i,
    ],
  },
  {
    category: 'encoded-instruction',
    reason: 'Content contains an encoded or obfuscated instruction that must not reach a downstream model unchecked.',
    patterns: [
      /\b(?:decode|decrypt|deobfuscate|unescape|base64[-\s]?decode)\w*\b[^\n]{0,80}\b(?:follow|execute|run|obey|comply\s+with|apply|carry\s+out|act\s+on)\s+(?:the\s+|those\s+|these\s+|its\s+|them\s+as\s+|it\s+as\s+)?(?:instructions?|commands?|directives?|steps|prompts?|payload|(?:resulting|decoded)\s+(?:text|instructions?|commands?))\b/i,
      /\b(?:base64|base\s*64|rot\s*13|hex(?:-|\s)?encoded|encoded|obfuscated|hidden|invisible|encrypted)\s+(?:instructions?|prompts?|commands?|directives?|payloads?)\b/i,
    ],
  },
  {
    category: 'download-execute',
    reason: 'Content combines a remote-download mechanism with execution of the downloaded result.',
    patterns: [
      /\b(?:curl|wget|iwr|invoke-webrequest|certutil|bitsadmin)\b[^\n]{0,300}?\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|perl|pwsh|powershell)\b/i,
      /\b(?:bash|sh|zsh)\s+-c\s+["'`$(]*\s*(?:curl|wget)\b/i,
      /\b(?:curl|wget)\b[^\n]{0,200}\s(?:-o|-O|--output)\s[^\n]{0,120}?(?:&&|;)\s*(?:chmod\s+\+x|\.\/|sh\s|bash\s|python3?\s|node\s)/i,
      // Prose form: "use curl to download X and run it".
      /\b(?:curl|wget|download)\w*\b[^\n]{0,80}\b(?:and|then)\s+(?:run|execute|launch)\s+(?:it|them|the\s+(?:result|script|file|binary|output|installer))\b/i,
    ],
  },
  {
    category: 'secret-exfiltration',
    reason: 'Content asks for credentials, private data, or environment values to be transmitted to an external destination.',
    // An explicit external destination is a finding on its own.
    patterns: [new RegExp(exfilVerb('(?:your|all|any|the|every)') + EXTERNAL_DESTINATION, 'i')],
    // A vaguer destination ("the diagnostic endpoint") must address the
    // reader's OWN secrets ("your token") with a model target nearby — so
    // documentation of how this app's peers send the credential to the
    // server is not one.
    nearModelTarget: [new RegExp(exfilVerb('your') + VAGUE_DESTINATION, 'gi')],
  },
  {
    category: 'reviewer-control',
    reason: 'Content attempts to control a downstream review, approval, comment, label, or merge decision.',
    patterns: [
      /\b(?:you|the\s+(?:ai|automated|llm)\s+(?:reviewer|agent|assistant|model))\s+(?:must|have\s+to|need\s+to|are\s+(?:required|instructed|expected)\s+to)\s+(?:now\s+)?(?:approve|merge|accept|mark\s+(?:this|it)\s+(?:as\s+)?(?:safe|eligible|approved)|skip|ignore|bypass)\b/i,
      /\b(?:mark|flag|treat|classify)\s+(?:this|the)\s+(?:pr|pull\s+request|change|patch|diff)\s+(?:as\s+)?(?:safe|eligible|approved|trusted|benign)\b/i,
    ],
    nearModelTarget: [/\b(?:approve|merge|accept|lgtm)\w*\b[^\n]{0,60}\b(?:immediately|automatically|without\s+(?:review|reading|approval|checking|running|changes|further)|regardless|no\s+matter|unconditionally|blindly)\b/gi],
  },
];

/**
 * High-confidence, content-only checks that run before (and, when the
 * classifier is not installed, instead of) the classifier. They look for the
 * two things a human reader can miss: content designed to hide from the human
 * — invisible or direction-control code points, comments GitHub never renders
 * — and obvious instructions that would be harmful if a model read them as
 * its own. Every rule is shape-specific with single-line gaps, so a diff that
 * merely mentions "payload" in one hunk and "agent" in another is not a
 * finding. Findings carry generic explanations and never quote the source
 * text, so a finding cannot become another injection channel when displayed.
 */
export function detectDeterministicModelAbuseSignals(value) {
  if (typeof value !== 'string' || !value) return [];
  const findings = [];

  const hidden = hiddenCodePointSummary(value);
  if (hidden) {
    findings.push(blockingFinding('hidden-unicode', `Content contains invisible or direction-control Unicode (${hidden}) that a human reader would not see but a model would read.`));
  }

  const hiddenComment = [...value.matchAll(HIDDEN_COMMENT_RE)].some((match) => {
    const body = match[1] ?? match[2] ?? '';
    return HIDDEN_COMMENT_ABUSE_RE.test(body) && (MODEL_TARGET_RE.test(body) || SECOND_PERSON_RE.test(body));
  });
  if (hiddenComment) {
    findings.push(blockingFinding('hidden-comment-instruction', 'Content hides a model-directed instruction inside a comment that the rendered pull request never shows a human.'));
  }

  for (const rule of VISIBLE_TEXT_RULES) {
    if (
      rule.patterns.some((re) => re.test(value))
      || (rule.nearModelTarget || []).some((re) => nearModelTarget(value, re))
    ) {
      findings.push(blockingFinding(rule.category, rule.reason));
    }
  }

  return findings;
}

function normalizeLabel(label) {
  if (typeof label !== 'string') return null;
  const normalized = label.trim().toUpperCase();
  if (normalized === 'BENIGN' || normalized === 'LABEL_0') return 'benign';
  if (normalized === 'MALICIOUS' || normalized === 'LABEL_1') return 'malicious';
  return null;
}

/**
 * Validate the small, machine-generated classifier envelope. No prose or
 * source excerpts are accepted. An unknown label, missing chunk, low score, or
 * contradictory result is explicitly inconclusive and must fail closed.
 */
export function normalizeModelAbuseGuardResult(raw, { minBenignScore = MODEL_ABUSE_GUARD_MIN_BENIGN_SCORE } = {}) {
  const chunks = raw?.chunks;
  if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > MODEL_ABUSE_GUARD_MAX_CHUNKS) {
    return { ok: false, code: 'security-guard-verdict-invalid' };
  }

  const normalized = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const label = normalizeLabel(chunk?.label);
    const score = Number(chunk?.score);
    if (
      !chunk || typeof chunk !== 'object' || Array.isArray(chunk)
      || chunk.index !== index
      || !label || !Number.isFinite(score) || score < 0 || score > 1
      || !Number.isInteger(chunk.tokenStart) || chunk.tokenStart < 0
      || !Number.isInteger(chunk.tokenEnd) || chunk.tokenEnd <= chunk.tokenStart
    ) {
      return { ok: false, code: 'security-guard-verdict-invalid' };
    }
    normalized.push({
      index,
      label,
      score,
      tokenStart: chunk.tokenStart,
      tokenEnd: chunk.tokenEnd
    });
  }

  const malicious = normalized.filter((chunk) => chunk.label === 'malicious');
  if (malicious.length > 0) {
    return {
      ok: true,
      safe: false,
      code: 'security-guard-classified-malicious',
      findings: [blockingFinding('prompt-classifier', 'The dedicated model-abuse classifier marked one or more complete content windows as malicious.')],
      chunkCount: normalized.length,
      minBenignScore: null
    };
  }

  const minScore = Math.min(...normalized.map((chunk) => chunk.score));
  if (!Number.isFinite(minBenignScore) || minBenignScore < 0 || minBenignScore > 1 || minScore < minBenignScore) {
    return {
      ok: true,
      safe: false,
      code: 'security-guard-low-confidence',
      findings: [blockingFinding('prompt-classifier-confidence', 'The dedicated model-abuse classifier did not clear every content window at the required confidence threshold.')],
      chunkCount: normalized.length,
      minBenignScore: minScore
    };
  }

  return {
    ok: true,
    safe: true,
    code: 'security-guard-passed',
    findings: [],
    chunkCount: normalized.length,
    minBenignScore: minScore
  };
}

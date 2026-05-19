
import { join } from 'path';
import { getSettings } from './settings.js';
import { getProviderById, getAllProviders } from './providers.js';
import { buildRulesPromptSection } from './messageTriageRules.js';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';
import { extractJson } from '../lib/jsonExtract.js';

const EVAL_PROMPT = `You are an email triage assistant. For each email below, recommend ONE action and a brief reason.

Actions:
- reply: Email requires or warrants a response from the user
- archive: Informational, no action needed (newsletters, notifications, FYI)
- delete: Junk, spam, or irrelevant
- review: Needs the user to read but no reply needed (meeting invites, action items)

Respond with ONLY a JSON array, one object per email:
[{ "id": "MSG_ID", "action": "reply|archive|delete|review", "reason": "brief reason", "priority": "high|medium|low" }]

<emails>
`;

const EVAL_PROMPT_SUFFIX = `</emails>`;

/**
 * Sanitize untrusted email content by escaping XML-like tags to prevent prompt injection.
 */
function sanitize(text) {
  if (!text) return '';
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEvalPayload(messages) {
  return messages.map(m => ({
    id: m.id,
    from: sanitize(m.from?.name || m.from?.email || 'Unknown'),
    subject: sanitize(m.subject || '(no subject)'),
    preview: sanitize((m.bodyText || '').slice(0, 300)),
    isUnread: m.isUnread ?? !m.isRead,
    isFlagged: m.isFlagged ?? false,
    hasMeetingInvite: m.hasMeetingInvite ?? false
  }));
}

/**
 * Resolve provider config for a given action type (triage or reply).
 * Supports per-action config: settings.messages.triage / settings.messages.reply
 * Falls back to legacy flat config: settings.messages.providerId / settings.messages.model
 */
async function resolveProviderConfig(actionType) {
  const settings = await getSettings();
  const msgConfig = settings?.messages || {};
  const actionConfig = msgConfig[actionType] || {};
  let providerId = actionConfig.providerId || msgConfig.providerId;
  let model = actionConfig.model || msgConfig.model;

  // Fall back to the first enabled provider if none is explicitly configured
  if (!providerId) {
    const { providers } = await getAllProviders();
    const fallback = providers.find(p => p.enabled);
    if (!fallback) throw new Error(`No AI provider configured for Messages ${actionType} — set one in Messages > Config`);
    providerId = fallback.id;
    model = model || fallback.defaultModel || '';
  }

  const provider = await getProviderById(providerId);
  if (!provider) throw new Error(`AI provider "${providerId}" not found`);

  return { provider, model: model || provider.defaultModel || '', msgConfig };
}

async function runPrompt(provider, model, prompt, source) {
  // promptRunner internally gates per-call model overrides for providers
  // that don't honor them (non-codex CLI). Surface the effective model
  // it actually used so callers can log it accurately instead of echoing
  // back the (possibly-dropped) input model.
  const { text, model: effectiveModel } = await runPromptThroughProvider({ provider, model, prompt, source });
  return { text, model: effectiveModel };
}

function parseEvalResponse(text, messageIds) {
  // Route through the shared extractor so banner-stripping, trailing-comma
  // repair, and the `[...]` placeholder elision the rest of PortOS's LLM
  // callers benefit from also apply here. Without it, a Codex banner before
  // the JSON or a stray trailing comma throws SyntaxError instead of
  // surfacing the cleaner "Failed to parse AI evaluation response" upstream.
  const { value: parsed } = extractJson(text, { blockType: 'array' });
  if (!Array.isArray(parsed)) return null;

  // Index by message ID, only keep valid entries
  const validActions = new Set(['reply', 'archive', 'delete', 'review']);
  const validPriorities = new Set(['high', 'medium', 'low']);
  const result = {};
  for (const entry of parsed) {
    if (!entry.id || !messageIds.has(entry.id)) continue;
    result[entry.id] = {
      action: validActions.has(entry.action) ? entry.action : 'review',
      reason: String(entry.reason || '').slice(0, 200),
      priority: validPriorities.has(entry.priority) ? entry.priority : 'medium'
    };
  }
  return result;
}

/**
 * Evaluate a batch of messages and return action recommendations.
 * @param {Array} messages - Messages to evaluate
 * @returns {{ evaluations: Object<messageId, { action, reason, priority }> }}
 */
export async function evaluateMessages(messages) {
  if (!messages.length) return { evaluations: {} };

  const { provider, model } = await resolveProviderConfig('triage');

  const payload = buildEvalPayload(messages);
  const rulesSection = await buildRulesPromptSection();
  const prompt = EVAL_PROMPT + rulesSection + JSON.stringify(payload, null, 2) + '\n' + EVAL_PROMPT_SUFFIX;

  console.log(`📧 Evaluating ${messages.length} messages with ${provider.name}`);
  const { text: response, model: effectiveModel } = await runPrompt(provider, model, prompt, 'messages-triage');
  console.log(`📧 Triage ran on ${provider.name}/${effectiveModel || '(default)'}`);

  const messageIds = new Set(messages.map(m => m.id));
  const evaluations = parseEvalResponse(response, messageIds);
  if (!evaluations) throw new Error('Failed to parse AI evaluation response');

  console.log(`📧 Evaluated ${Object.keys(evaluations).length}/${messages.length} messages`);
  return { evaluations };
}

// Voice document filenames ordered by relevance for email drafting
const VOICE_DOCS = ['SOUL.md', 'COMMUNICATION.md', 'PERSONALITY.md', 'VALUES.md', 'SOCIAL.md'];

/**
 * Load digital twin voice context documents for email drafting.
 * Returns a formatted prompt section with the user's communication style and personality.
 */
async function loadVoiceContext() {
  const contents = await Promise.all(
    VOICE_DOCS.map(filename =>
      tryReadFile(join(PATHS.digitalTwin, filename))
    )
  );
  const sections = contents
    .map((content, i) => content?.trim() ? `### ${VOICE_DOCS[i].replace('.md', '')}\n${content.trim()}` : null)
    .filter(Boolean);
  if (!sections.length) {
    console.log('📧 Voice mode enabled but no digital twin documents found');
    return '';
  }
  return `\n<voice_context>
The following documents describe the user's identity, communication style, and values.
Write the reply in their authentic voice — match their tone, directness, and personality.
Do NOT mention these documents or that you are an AI.

${sections.join('\n\n')}
</voice_context>\n`;
}

/**
 * Format thread messages into conversation context for the AI.
 */
function buildThreadContext(threadMessages) {
  if (!threadMessages?.length) return '';
  const formatted = threadMessages.map(m => {
    const from = m.from?.name || m.from?.email || 'Unknown';
    const date = m.date ? new Date(m.date).toLocaleString() : '';
    const body = sanitize((m.bodyText || '').slice(0, 500));
    return `[${date}] ${sanitize(from)}:\n${body}`;
  }).join('\n---\n');
  return `\n<thread_context>
Previous messages in this conversation:
${formatted}
</thread_context>\n`;
}

/**
 * Generate an AI reply draft for a message.
 * @param {object} message - The message to reply to
 * @param {string} instructions - Additional instructions
 * @param {object} options - { useVoice, threadMessages }
 * @returns {{ body: string }}
 */
export async function generateReplyBody(message, instructions = '', options = {}) {
  const { useVoice, threadMessages } = options;
  const { provider, model, msgConfig } = await resolveProviderConfig('reply');

  // Determine if voice mode is active (explicit param > settings default)
  const shouldUseVoice = useVoice ?? msgConfig.voiceMode ?? false;

  // Build prompt from template
  let template = msgConfig.replyTemplate || 'Write a professional reply to this email.\n\nFrom: {{from}}\nSubject: {{subject}}\nBody:\n{{body}}';
  // Sanitize untrusted email content to prevent prompt injection
  const vars = {
    from: sanitize(message.from?.name || message.from?.email || 'Unknown'),
    subject: sanitize(message.subject || ''),
    body: sanitize(message.bodyText || ''),
    instructions: instructions || ''
  };
  // Simple mustache-like substitution
  for (const [key, val] of Object.entries(vars)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
  }
  // Handle conditional blocks {{#key}}...{{/key}}
  template = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, block) => {
    return vars[key] ? block.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), vars[key]) : '';
  });

  // Prepend voice context if enabled
  if (shouldUseVoice) {
    const voiceContext = await loadVoiceContext();
    if (voiceContext) template = voiceContext + template;
  }

  // Append thread context if available
  const threadContext = buildThreadContext(threadMessages);
  if (threadContext) template += threadContext;

  const voiceLabel = shouldUseVoice ? ' with voice' : '';
  console.log(`📧 Generating AI reply${voiceLabel} with ${provider.name}`);
  const { text: response, model: effectiveModel } = await runPrompt(provider, model, template, 'messages-reply');
  console.log(`📧 Reply ran on ${provider.name}/${effectiveModel || '(default)'}`);
  return { body: response.trim() };
}

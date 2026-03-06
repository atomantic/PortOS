import { getSettings } from './settings.js';
import { getProviderById } from './providers.js';

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
  const providerId = actionConfig.providerId || msgConfig.providerId;
  const model = actionConfig.model || msgConfig.model;

  if (!providerId) throw new Error(`No AI provider configured for Messages ${actionType} — set one in Messages > Config`);

  const provider = await getProviderById(providerId);
  if (!provider) throw new Error(`AI provider "${providerId}" not found`);
  if (provider.type !== 'api') throw new Error(`Messages ${actionType} requires an API provider (not CLI)`);

  return { provider, model, msgConfig };
}

async function callProviderApi(provider, model, prompt) {
  const endpoint = provider.endpoint?.replace(/\/$/, '');
  if (!endpoint) throw new Error('Provider has no API endpoint');

  const body = {
    model: model || provider.defaultModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 2000
  };

  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  // Anthropic API uses x-api-key
  if (provider.id?.includes('claude') || provider.id?.includes('anthropic') || endpoint.includes('anthropic')) {
    headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body.messages = [{ role: 'user', content: prompt }];
    body.max_tokens = 2000;
    delete body.max_tokens;
    body.max_tokens = 2000;
  }

  const response = await fetch(endpoint + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Provider API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  // OpenAI-compatible response format
  return data.choices?.[0]?.message?.content || '';
}

function parseEvalResponse(text, messageIds) {
  // Extract JSON array from response (may have markdown fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
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
  const prompt = EVAL_PROMPT + JSON.stringify(payload, null, 2) + '\n' + EVAL_PROMPT_SUFFIX;

  console.log(`📧 Evaluating ${messages.length} messages with ${provider.name}/${model || provider.defaultModel}`);
  const response = await callProviderApi(provider, model, prompt);

  const messageIds = new Set(messages.map(m => m.id));
  const evaluations = parseEvalResponse(response, messageIds);
  if (!evaluations) throw new Error('Failed to parse AI evaluation response');

  console.log(`📧 Evaluated ${Object.keys(evaluations).length}/${messages.length} messages`);
  return { evaluations };
}

/**
 * Generate an AI reply draft for a message.
 * @param {object} message - The message to reply to
 * @param {string} instructions - Additional instructions
 * @returns {{ body: string }}
 */
export async function generateReplyBody(message, instructions = '') {
  const { provider, model, msgConfig } = await resolveProviderConfig('reply');

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

  console.log(`📧 Generating AI reply with ${provider.name}/${model || provider.defaultModel}`);
  const response = await callProviderApi(provider, model, template);
  return { body: response.trim() };
}

import { isCodexProvider } from '../../lib/providerModels.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';
import { localApiBaseUrl } from '../../lib/networkExposure.js';
import { agentApiCurl } from '../../lib/agentApiToken.js';

// Resolve at dispatch, rather than changing only the shipped security mission:
// customized prompts and already-queued audits need the same scanner guidance.
export function buildSecurityAuditRuntimeSection(task, { providerId, providerCommand, agentId } = {}) {
  // Match the identity used by source evidence, completion and score recording.
  const taskType = resolveTaskHookType(task);
  // An explicit executable wins over a stale provider id. Custom ids still
  // qualify when their command is Codex; model names alone never select it.
  const provider = { id: providerCommand ? null : providerId, command: providerCommand };
  if (taskType !== 'security' || !isCodexProvider(provider)) return '';

  const endpoint = `/api/cos/agents/${encodeURIComponent(agentId || '<agent-id>')}/security-scan`;
  const command = agentApiCurl({ apiBase: localApiBaseUrl(), path: endpoint });
  return `## Codex Security Audit Runtime
After reading the target threat model and completing repository-wide discovery, request the scanner phase through the PortOS runner. Write a private JSON request file containing only:
{ "prompt": "The actual threat model, selected audit area and report-only restrictions", "paths": ["relative/source/path"], "knowledgeBase": ["AGENTS.md"] }
Choose real workspace-relative files; include available architecture/security documents in knowledgeBase. Keep outer issue-filing and completion commands out of the scanner prompt.

Call once: \`${command} --data-binary @<private-request-file>\`.
The runner owns the installed Codex Security CLI, enforces this run's resolved model and effort, subscription ChatGPT authentication, a $2 API-equivalent estimated-cost cap and a 180-second scan limit. Those settings cannot be changed in the request. No installation, API-key fallback, additional workers, patching or publication is permitted. Do not invoke a separate CLI, SDK or cloud scan: an unavailable runner/installation/model is a visible limitation, not permission for a different execution path.

The response contains trusted runner evidence plus a private artifactDirectory. Read any saved findings/coverage there, challenge reachability against callers/tests/history, and preserve this task's remediation/file-issues mode and delivery requirements. Do not call the scanner again after any result or transport error; the runner retains one attempt and its diagnostics independently of your completion. Finish permitted source inspection and deliver supported findings even when another probe is blocked.

A cybersecurity/content-policy refusal is terminal for this request: stop clearly. Do not continue, retry, rephrase to evade a refusal, or switch providers. This overrides recovery guidance below. The runner also stops the outer request on a scanner refusal.

Report scanner execution separately from delivery and quality assessment. Runner-observed model/effort/auth, limits, exit and artifact evidence are authoritative; a saved assessment or successful outer task does not make an interrupted scan successful. Estimated cost is API-equivalent usage, not proof of charges. Do not claim unknown evidence as zero or success. Complete the normal sentinel and exactly one QUALITY_AUDIT_JSON assessment for work actually performed, with partial/unavailable coverage when warranted. SCANNER_STATUS_JSON is a legacy agent-report format; it cannot override runner evidence.
`;
}

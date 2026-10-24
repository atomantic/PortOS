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
Before vulnerability discovery or active testing, read the repository instructions and documented threat model, enumerate the files needed to establish scope, then request the scanner phase through the PortOS runner. Codex Security performs the initial vulnerability investigation; the outer agent coordinates the scan and validates its evidence afterwards. This ordering takes precedence over the mission's discovery/investigation steps. Write a private JSON request file containing only:
{ "prompt": "The actual threat model, selected audit area and report-only restrictions", "paths": ["."], "knowledgeBase": ["AGENTS.md"] }
Use paths ["."] for a repository-wide audit, or committed workspace-relative paths when the task explicitly limits scope. Include only existing committed instructions and architecture/security documents in knowledgeBase; use [] when none exist. The runner scans a private standalone snapshot of committed HEAD: uncommitted, untracked and ignored files and submodules are excluded; symlinks are represented as recorded link text. Every scanner input is mapped into that snapshot, so ordinary worktree edits cannot change its target. Keep outer issue-filing and completion commands out of the scanner prompt. Installing Codex Security does not grant broader cyber access or exempt either phase from provider safeguards.

Request one scanner execution: \`${command} --max-time 0 --data-binary @<private-request-file>\`.
The runner owns the installed Codex Security CLI and enforces this run's saved grant: resolved model and effort, subscription ChatGPT authentication, saved limits. New grants explicitly record unlimited for both maxCostUsd and timeLimitSeconds: no PortOS estimate cap or elapsed-time deadline. Read the actual limits from runner evidence; saved grants retain their original limits. Unknown or absent evidence is not proof of unlimited execution. Provider quota, rate and safety limits still apply. Those settings cannot be changed in the request. Wait for the single request to finish; a quiet response does not authorize another execution. No installation, API-key fallback, additional workers, patching or publication is permitted. Do not invoke a separate CLI, SDK or cloud scan: an unavailable runner/installation/model is a visible limitation, not permission for a different execution path.

The response contains trusted runner evidence plus a private artifactDirectory. Read any saved findings/coverage there, challenge reachability against callers/tests/history, and preserve this task's remediation/file-issues mode and delivery requirements. Only an explicit runner status of invalid-input permits correction: no scanner has launched. Use preflight.lastError's field and zero-based index to locate the bad input, verify the replacement in the workspace, and submit corrected paths through this same endpoint. Concurrent requests share the current result. Do not resubmit after any other result or transport error; the runner retains one execution and its diagnostics independently of your completion. A stopped or restarted grant cannot be reopened. Finish permitted source inspection and deliver supported findings even when another probe is blocked.

A cybersecurity/content-policy refusal is terminal for this request: stop clearly. Do not continue, retry, rephrase to evade a refusal, or switch providers. This overrides recovery guidance below. The runner also stops the outer request on a scanner refusal.

Report scanner execution separately from delivery and quality assessment. Runner-observed model/effort/auth, limits, baseline commit/tree, exit and artifact evidence are authoritative; a saved assessment or successful outer task does not make an interrupted scan successful. Revalidate findings against current source before remediation; scanning the baseline does not certify subsequent repairs. Short-context estimates are API-equivalent usage, not billed charges or ChatGPT subscription quota. Do not claim unknown evidence as zero or success. Complete the normal sentinel and exactly one QUALITY_AUDIT_JSON assessment for work actually performed, with partial/unavailable coverage when warranted. SCANNER_STATUS_JSON is a legacy agent-report format; it cannot override runner evidence.
`;
}

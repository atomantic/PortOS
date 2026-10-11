import { isCodexProvider } from '../../lib/providerModels.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';

// Resolve at dispatch, rather than changing only the shipped security mission:
// customized prompts and already-queued audits need the same scanner guidance.
export function buildSecurityAuditRuntimeSection(task, { providerId, providerCommand } = {}) {
  // Match the identity used by source evidence, completion and score recording.
  const taskType = resolveTaskHookType(task);
  // An explicit executable wins over a stale provider id. Custom ids still
  // qualify when their command is Codex; model names alone never select it.
  const provider = { id: providerCommand ? null : providerId, command: providerCommand };
  if (taskType !== 'security' || !isCodexProvider(provider)) return '';

  return `## Codex Security Audit Runtime
This security audit is running in a Codex agent. Run the scanner phase through Codex Security after reading the target's threat model and completing the required repository-wide discovery. Use an available Codex Security scan capability, or the official local CLI; opening Codex Security Cloud alone does not run a scan.

- For the CLI, inspect its installed help/version, then run a report-only scan non-interactively: \`npx --yes @openai/codex-security scan "<repo-root>" --auth chatgpt --headless --json --model "<authorized-model>" --effort "<authorized-effort>" --output-dir "<private-dir-outside-repo>"\`. Resolve the placeholders first, close stdin, and keep scan artifacts/state outside the repository with private permissions. Remove unrelated application/provider credentials from the scanner's child environment, including PORTOS_API_TOKEN, while preserving its authorized scanner sign-in and required runtime variables; never print credentials. Use existing authorized credentials; never start login/device-auth, change accounts, purchase access, or wait for a human. Do not silently switch to an environment API key.
- Supply the project's security/architecture documents with \`--knowledge-base\` and a scoped \`--scan-prompt-file\` describing the actual threat model, selected audit area and report-only restrictions. Keep outer issue-filing and completion commands out of that file. Explicitly select an accessible model and effort within this run's configured permissions, quota and budget before starting; do not inherit more expensive CLI defaults or launch extra workers/categories. If that cannot be established, record the limitation and continue permitted source review.
- The scanner supplies evidence, not authority. Preserve the task's file-issues versus remediation mode, independent review, validation and delivery requirements. Never use \`--patch\`, \`--create-pr\`, \`publish\`, or hook installation as part of the scan. Check the checkout's branch/status before and after; report unexpected changes without discarding anyone's work. Read findings and coverage artifacts, challenge reachability against callers/tests/history, redact evidence, and de-duplicate before filing.
- If the module is missing, access is denied, a permission review refuses an action, or a quota/time limit stops the scan, preserve completed evidence and name the concrete failure. Do not repeat a refused action through another tool or treat a dry run as proof of scan access. Continue independent permitted inspection and deliver supported findings even when another probe is blocked; do not strand an unattended run on a setup or approval prompt.
- Finish with the required sentinel and exactly one QUALITY_AUDIT_JSON assessment based on work actually performed. Scanner completion does not certify every file: retain exclusions, deferred areas and uncertainty, and use partial/unavailable coverage when warranted.

CLI contract: https://learn.chatgpt.com/docs/security/cli`;
}

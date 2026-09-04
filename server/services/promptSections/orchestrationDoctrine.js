/**
 * Architect-doctrine prompt section for orchestrated CoS runs (#5992).
 *
 * An orchestrated task's top-level agent is the ARCHITECT: it plans, writes a
 * spec per unit of work, and delegates execution to lanes running on cheaper
 * models. The delegated lane shares NONE of the architect's context — it sees
 * only the spec text — so a spec that omits any of the six parts is a lane that
 * has to guess, and guessing is what makes cheap-model delegation fail.
 *
 * The section is the whole delivery mechanism for the per-step reasoning rung:
 * PortOS cannot intercept an agent's own sub-agent dispatch, so the contract is
 * stated here and the architect writes `REASONING: <rung>` into each spec, which
 * `thinkingLevels.resolveStepEffort` then reads back without rounding.
 *
 * Renders '' for every `direct`-mode task, which is every task by default.
 */

import { ORCHESTRATION_ROLES, SPEC_PARTS, isOrchestratedTask, roleAssignment } from '../../lib/orchestrationProfile.js';

const ROLE_DUTIES = {
  architect: 'plan, write one spec per unit of work, delegate, then integrate and judge what comes back',
  implementer: 'execute exactly one spec at a time, with no context beyond that spec',
  reviewer: 'check a completed unit against its spec and report, without rewriting it',
};

function roleLine(task, role) {
  const assignment = roleAssignment(task, role);
  const pins = [
    assignment?.provider ? `provider \`${assignment.provider}\`` : null,
    assignment?.model ? `model \`${assignment.model}\`` : null,
    assignment?.effort ? `default reasoning \`${assignment.effort}\`` : null,
  ].filter(Boolean);
  const target = pins.length ? pins.join(', ') : 'this run’s own provider and model';
  return `- **${role}** — ${ROLE_DUTIES[role]}. Runs on ${target}.`;
}

/**
 * The `## Orchestrated Execution` section for one task, or '' when the task is
 * not orchestrated.
 *
 * @param {object} task
 * @returns {string}
 */
export function buildOrchestrationDoctrineSection(task) {
  if (!isOrchestratedTask(task)) return '';
  return [
    '## Orchestrated Execution',
    '',
    'You are the **architect** for this run. Your output is specs and integration, not code you wrote yourself.',
    '',
    ...ORCHESTRATION_ROLES.map(role => roleLine(task, role)),
    '',
    '**Delegate exploration.** Do not spend your own context reading the repository to find things. Send a sub-agent to locate the files, signatures, and conventions, and have it report back the findings — not the file contents.',
    '',
    '**Emit specs, not code.** Break the work into units that one lane can finish alone, and hand each lane a spec carrying ALL SIX parts below. The lane sees only what you write; anything you leave implicit, it will invent.',
    '',
    ...SPEC_PARTS.map(part => `- \`${part.label}:\` — ${part.description}`),
    '',
    `Write each part on its own line, labeled exactly as above. The \`${SPEC_PARTS[SPEC_PARTS.length - 1].label}\` rung is passed through to the lane unchanged — it is never rounded to a level the lane happens to support, so name a rung from the list or the step is rejected rather than quietly downgraded.`,
    '',
    '**Integrate deliberately.** A returned unit is done when its own `VERIFICATION` command passes. Run it yourself before you build on the unit; do not take the lane’s word for it.',
  ].join('\n');
}

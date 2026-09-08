/**
 * How the Agent Operations panel renders the bundled slashdo workflows (#3114).
 *
 * WHICH workflows exist, what each does, and which app types each applies to are
 * defined once in `server/lib/slashdoCatalog.js` and read from there — the panel
 * cannot be a workflow short, and a description cannot say two different things
 * on the two sides. What stays here is the button styling the server has no
 * business knowing: `WORKFLOW_TONE` maps a command to a Tailwind class set, and
 * `SLASHDO_WORKFLOWS` is the server list decorated with it.
 */
import { SLASHDO_WORKFLOWS as SERVER_WORKFLOWS, slashdoWorkflowAppliesTo } from '../../../server/lib/slashdoCatalog.js';

export { SLASHDO_APP_TYPES } from '../../../server/lib/slashdoCatalog.js';

/**
 * slashdo's command namespace. Kept local rather than imported from
 * `server/lib/slashdoInvocation.js`, which owns it: that module reaches for the
 * provider registry and is not importable from a browser bundle.
 */
export const SLASHDO_NAMESPACE = 'do';

/**
 * How a slashdo workflow is SPELLED in PortOS UI — `/do:review`. Users know these
 * workflows by their Claude Code slash-command form, so that's what buttons,
 * chips, and tooltips show. This is a UI string only: the shape actually sent to
 * an agent is resolved per provider server-side (`resolveSlashdoInvocation`), and
 * for a codex/grok host it is a skill name, not a slash command.
 * @param {string} command - bare command name (`plan-task`)
 * @returns {string}
 */
export function slashdoLabel(command) {
  return `/${SLASHDO_NAMESPACE}:${command}`;
}

const CLASSES = {
  success: 'bg-port-success/20 text-port-success hover:bg-port-success/30 border-port-success/30',
  accent: 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30',
  cyan: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border-cyan-500/30',
  blue: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border-blue-500/30',
  purple: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border-purple-500/30',
  warning: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30',
  slate: 'bg-slate-500/20 text-slate-300 hover:bg-slate-500/30 border-slate-500/30',
};

// Button tone per workflow. A command with no row falls back to `slate`, so a
// workflow added server-side renders as a working (if unstyled) button rather
// than as `className="… undefined …"`.
const WORKFLOW_TONE = {
  'plan-task': CLASSES.slate,
  next: CLASSES.blue,
  replan: CLASSES.cyan,
  review: CLASSES.accent,
  push: CLASSES.success,
  release: CLASSES.purple,
  better: CLASSES.warning,
  'better-swift': CLASSES.warning,
  depfree: CLASSES.slate,
  scan: CLASSES.slate,
};

/**
 * @typedef {Object} SlashdoWorkflowButton
 * @property {string} command - bare slashdo command name (`plan-task`)
 * @property {string} description - button tooltip
 * @property {string} appTypes - one of SLASHDO_APP_TYPES
 * @property {boolean} [configurable] - opens the run-settings drawer instead of
 *   queuing immediately
 * @property {string} classes - Tailwind classes for the button
 */

/** @type {ReadonlyArray<SlashdoWorkflowButton>} */
export const SLASHDO_WORKFLOWS = Object.freeze(SERVER_WORKFLOWS.map((workflow) => Object.freeze({
  ...workflow,
  classes: WORKFLOW_TONE[workflow.command] || CLASSES.slate,
})));

/**
 * The workflows launchable for one app, filtered by its Swift-ness. `better` and
 * `better-swift` are the same audit for different stacks, so exactly one of them
 * shows per app.
 * @param {boolean} isSwiftApp
 * @returns {SlashdoWorkflowButton[]}
 */
export function slashdoWorkflowsForApp(isSwiftApp) {
  return SLASHDO_WORKFLOWS.filter((workflow) => slashdoWorkflowAppliesTo(workflow, isSwiftApp));
}

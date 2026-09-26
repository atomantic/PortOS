/**
 * Built-in Layer-1 telemetry source keys shared by the server schema and the
 * client settings form. Kept in a dependency-free leaf so importing the
 * broad layered-intelligence reader is not required to build a route schema.
 */
export const LAYERED_INTELLIGENCE_SOURCE_KEYS = [
  'goals',
  // The app's own success/performance metrics doc (METRICS.md in the app repo).
  // Default on: the primary signal for judging a managed app against its goals.
  'appMetrics',
  'cosMetrics',
  'healthReport',
  'planMd',
  'openIssues',
  // The committed backlog (#2698): `plan`-labeled tracker issues / the
  // prioritized Jira backlog / PLAN.md's unchecked items, fed in so the reasoner
  // can suppress a proposal that overlaps work already in scope. Default on.
  'plannedWork',
  // PortOS-only product-success signals (POST engagement and creative
  // commission feedback). Managed apps use appMetrics/custom sources.
  'productMetrics',
  // Feedback loop (#2428): feed past LI proposals + their tracker outcomes back
  // into the reasoning prompt. Default on for PortOS, off for managed apps.
  'outcomes',
  // Self-evaluation (#2700): fold LI's own merge rate, already-filed proposal
  // count, and agent-run health back into the prompt so the loop can judge its
  // proposal quality before filing. Default on for PortOS, off for managed apps.
  'selfEval',
];

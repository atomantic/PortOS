/**
 * Contracts for the persistent mind's forge-issue capability.
 *
 * Filing an issue is the queueing lane that works on an install with no coding
 * agent attached: the mind cannot dispatch a CoS task there, but it can still
 * read the open backlog and write down work for whoever (or whatever) picks the
 * tracker up next. Keeping the schemas beside the capability catalog means the
 * tool registry, the route, and the settings UI describe one contract.
 *
 * Dispatch labels are REQUIRED on a filed issue, exactly as they are for a human
 * planner (AGENTS.md "Capture deferred work"): an issue with no `model:`/`effort:`
 * axis is not dispatchable, so the schema refuses to file one rather than letting
 * the backlog fill with work no runner can size.
 */

import { z } from 'zod';
import { DISPATCH_EFFORT_LEVELS, DISPATCH_MODEL_TIERS } from './dispatchLabels.js';

export const PERSISTENT_MIND_ISSUE_LIMITS = Object.freeze({
  appIdChars: 128,
  titleChars: 200,
  bodyChars: 12_000,
  labelChars: 60,
  maxCategoryLabels: 4,
  maxListLimit: 50,
  defaultListLimit: 20,
  // The listing is prompt context, not an issue reader: enough body to judge
  // overlap with what the mind is about to file, never the whole thread.
  bodyPreviewChars: 600,
  searchChars: 200,
});

/**
 * The marker label every mind-filed issue carries, so the backlog can be read by
 * author and a later wake can find its own earlier proposals without guessing
 * from prose.
 */
export const PERSISTENT_MIND_ISSUE_LABEL = 'persistent-mind';

/**
 * The category labels a mind-filed issue may carry, with the colors used to
 * create them lazily.
 *
 * A closed vocabulary rather than free text: `gh issue create --label` fails the
 * WHOLE call with a 422 when the repo has never defined the label, so an invented
 * name would not file a mislabeled issue — it would file nothing, and the mind
 * would read a forge error it cannot act on. Every name here is either a PortOS
 * convention label (`plan`) or a GitHub default.
 */
export const PERSISTENT_MIND_ISSUE_CATEGORY_LABELS = Object.freeze({
  plan: { color: '0E8A16', description: 'Committed backlog item' },
  bug: { color: 'D73A4A', description: "Something isn't working" },
  tests: { color: 'C5DEF5', description: 'Test coverage or harness work' },
  ux: { color: 'D4C5F9', description: 'User-experience change' },
  docs: { color: '0075CA', description: 'Documentation change' },
  chore: { color: 'FEF2C0', description: 'Maintenance work with no user-facing change' },
});

/**
 * Every label this capability may create, keyed by name, in the
 * `{ color, description }` shape `dispatchLabelSpec` returns for the labels IT
 * owns. The filer chains the two, so a label has exactly one definition and
 * neither table needs to know about the other.
 */
export const PERSISTENT_MIND_ISSUE_EXTRA_LABEL_SPECS = Object.freeze({
  [PERSISTENT_MIND_ISSUE_LABEL]: { color: '5319E7', description: 'Filed by the PortOS persistent mind' },
  ...PERSISTENT_MIND_ISSUE_CATEGORY_LABELS,
});

const appIdSchema = z.string().trim().min(1).max(PERSISTENT_MIND_ISSUE_LIMITS.appIdChars);

export const persistentMindIssueListSchema = z.object({
  appId: appIdSchema,
  limit: z.number().int().min(1).max(PERSISTENT_MIND_ISSUE_LIMITS.maxListLimit).optional(),
  // Substring match over title and body, applied locally to the fetched page —
  // the forge query stays one plain open-issue listing on both CLIs.
  search: z.string().trim().min(1).max(PERSISTENT_MIND_ISSUE_LIMITS.searchChars).optional(),
  label: z.string().trim().min(1).max(PERSISTENT_MIND_ISSUE_LIMITS.labelChars).optional(),
}).strict();

export const persistentMindIssueFileSchema = z.object({
  appId: appIdSchema,
  title: z.string().trim().min(1).max(PERSISTENT_MIND_ISSUE_LIMITS.titleChars),
  body: z.string().trim().min(1).max(PERSISTENT_MIND_ISSUE_LIMITS.bodyChars),
  // Two independent dispatch axes. Neither is derived from the other, and both
  // are required — see the module comment.
  model: z.enum([...DISPATCH_MODEL_TIERS]),
  effort: z.enum([...DISPATCH_EFFORT_LEVELS]),
  labels: z.array(z.enum(Object.keys(PERSISTENT_MIND_ISSUE_CATEGORY_LABELS)))
    .max(PERSISTENT_MIND_ISSUE_LIMITS.maxCategoryLabels).optional(),
}).strict();

/**
 * A title reduced to its comparable identity, for the duplicate guard: case,
 * punctuation, and spacing carry no meaning when deciding whether the mind is
 * about to re-file work already in the tracker.
 */
export const normalizeIssueTitleKey = (title) => String(title || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

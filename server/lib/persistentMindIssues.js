/**
 * Persistent-mind forge-issue contracts: list/file schemas, dispatch axes, category labels and the duplicate-guard title key.
 *
 * Persistent-mind forge-issue contracts: bounded list/file schemas, the required-both dispatch axes, the closed category-label vocabulary with its lazily-created colors, the `persistent-mind` attribution label, and the title key the duplicate guard compares on.
 *
 * Filing an issue is the queueing lane that works with no coding agent attached (the mind can't dispatch a CoS task there but can read the backlog and write down work); schemas sit beside the capability catalog so the tool registry, route and settings UI describe one contract.
 * Dispatch labels are REQUIRED, as for a human planner (AGENTS.md "Capture deferred work"): an issue without a `model:`/`effort:` axis isn't dispatchable, so the schema refuses it rather than filling the backlog with work no runner can size.
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
  // The listing is prompt context, not an issue reader: enough body to judge overlap with what the mind is about to file, never the whole thread.
  bodyPreviewChars: 600,
  searchChars: 200,
});

/** The marker label every mind-filed issue carries, so the backlog can be read by author and a later wake finds its own earlier proposals without guessing from prose. */
export const PERSISTENT_MIND_ISSUE_LABEL = 'persistent-mind';

/**
 * The category labels a mind-filed issue may carry, with the colors used to create them lazily. A closed vocabulary: `gh issue create --label` fails the WHOLE call with a 422 when the repo never defined the label, so an invented name files nothing and the mind reads a forge error it can't act on.
 * Every name is a PortOS convention label (`plan`) or a GitHub default.
 */
export const PERSISTENT_MIND_ISSUE_CATEGORY_LABELS = Object.freeze({
  plan: { color: '0E8A16', description: 'Committed backlog item' },
  bug: { color: 'D73A4A', description: "Something isn't working" },
  tests: { color: 'C5DEF5', description: 'Test coverage or harness work' },
  ux: { color: 'D4C5F9', description: 'User-experience change' },
  docs: { color: '0075CA', description: 'Documentation change' },
  chore: { color: 'FEF2C0', description: 'Maintenance work with no user-facing change' },
});

/** Every label this capability may create, keyed by name, in the `{ color, description }` shape `dispatchLabelSpec` returns for the labels IT owns; the filer chains the two so each label has one definition. */
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

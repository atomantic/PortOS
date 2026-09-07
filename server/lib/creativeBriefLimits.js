/**
 * The caps on creative brief text: the commission brief fields, and the
 * Creative Director directive `goal` a commission's brief is composed into.
 *
 * A pure leaf on purpose. The Zod schemas that enforce these
 * (`creativeCommissionValidation.js`, `creativeDirectorValidation.js`) pull
 * `zod`, which the browser bundle is not handed — while the commission form and
 * the directive composer use the same numbers as an input `maxLength`, a SILENT
 * limit. A client cap below the schema's truncates a pasted brief at the
 * textarea with no error to explain where the tail went; one above it turns the
 * paste into a 400 at save time. Both sides import this one definition
 * (`client/src/components/creative-commission/commissionForm.js`,
 * `client/src/lib/creativeDirectorPlan.js`), so neither can drift. Import no
 * Node built-in here.
 */

export const COMMISSION_NAME_MAX = 200;
// The intent goes to the PLANNING LLM verbatim (via the CD directive `goal`), so
// it is sized to hold a full instruction set — a prompting framework, causation
// and camera rules, an audio policy, and a worked sample prompt — not a line of
// mood. For scale: MiniMax H3's documented 7000-character ceiling applies to the
// RENDER prompt the director writes downstream, and a brief that TEACHES how to
// write that prompt needs several times its length. Raising this also means
// raising MAX_DIRECTIVE_GOAL_LEN (services/creativeCommissions/directive.js).
export const COMMISSION_INTENT_MAX = 20000;
export const COMMISSION_STYLE_SPEC_MAX = 5000;
export const COMMISSION_BRIEF_TAG_MAX = 120;

// Kept clear of the commission scheduler's MAX_DIRECTIVE_GOAL_LEN (derived from
// the commission caps above plus the scheduler's own framing), so a goal it
// composes from a maxed-out commission brief also validates on the HTTP path.
// That ordering is asserted in services/creativeCommissions/directive.test.js —
// this leaf can't import the service to derive it.
export const CREATIVE_DIRECTOR_GOAL_MAX = 32000;

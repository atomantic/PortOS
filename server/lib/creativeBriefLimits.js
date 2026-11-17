/**
 * The caps on creative brief text: the commission brief fields, and the
 * Creative Director directive `goal` a commission's brief is composed into.
 *
 * A pure leaf (no `zod`, no Node built-ins) so the browser forms can import the
 * same numbers the Zod schemas enforce as a silent input `maxLength`; a client
 * cap that drifts below the schema truncates pastes, above it yields a 400 on save.
 */

export const COMMISSION_NAME_MAX = 200;
// The intent goes to the PLANNING LLM verbatim, so it must hold a full
// instruction set (prompting framework, camera rules, sample prompt), not a line
// of mood. Raising it also means raising MAX_DIRECTIVE_GOAL_LEN
// (services/creativeCommissions/directive.js).
export const COMMISSION_INTENT_MAX = 20000;
export const COMMISSION_STYLE_SPEC_MAX = 5000;
export const COMMISSION_BRIEF_TAG_MAX = 120;

// Must stay above the scheduler's MAX_DIRECTIVE_GOAL_LEN so a goal composed from
// a maxed-out commission brief also validates on the HTTP path; asserted in
// services/creativeCommissions/directive.test.js (this leaf can't import it).
export const CREATIVE_DIRECTOR_GOAL_MAX = 32000;

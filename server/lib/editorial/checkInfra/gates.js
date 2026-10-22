// Shared gate predicates for EDITORIAL_CHECKS entries.

/** True when the context carries drafted (non-whitespace) manuscript prose. */
export const hasManuscript = (ctx) => (ctx.manuscript || '').trim().length > 0;

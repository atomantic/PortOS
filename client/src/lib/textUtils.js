/**
 * The RegExp escape, from the module that owns it on both sides.
 *
 * Only `escapeRegExp` is re-exported — it is the only member the browser bundle
 * has a caller for, and a flat `export *` would put the server’s `countWords`
 * in the client barrel beside the one in `utils/formatters.js`.
 *
 * Imported rather than copied so the two runtimes cannot drift; the file stays so
 * every `lib/textUtils` import path in the client is unchanged.
 */
export { escapeRegExp } from '../../../server/lib/textUtils.js';

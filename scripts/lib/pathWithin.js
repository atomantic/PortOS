/**
 * `pathWithin(dir, ...segments)` for repository tooling: `path.join()` that
 * throws when the result is outside `dir`. The implementation lives in the root
 * `lib/pathWithin.js`, shared with `server/`; the test memo trusts the name as
 * imported from either module (docs/TEST_MEMO.md, "Variable path segments").
 */
export { pathWithin } from '../../lib/pathWithin.js';

// Pure rules for a managed app's hand-written audit path priorities: prompt-safe strings, size limits and the nested-glob conflict check.
//
// Shared by the app schema (server) and the Edit App editor (client), so the two refuse the same input. No I/O and no imports.
// The globs reach audit prompts, where a P3 glob becomes an inventory removal and a `--exclude '<glob>'` argument. A P3 path that
// contains a P0 or P2 path would silently drop explicitly prioritized code from the audit, and glob containment cannot be decided in
// general, so the nesting that can be read off the literal directory prefixes is rejected instead of resolved.

export const FEATURE_PRIORITY_MAX_ENTRIES = 50;
export const FEATURE_PRIORITY_MAX_PATHS = 20;
export const FEATURE_PRIORITY_MAX_LABEL = 80;
export const FEATURE_PRIORITY_MAX_PATH = 200;
export const FEATURE_PRIORITY_MAX_NOTE = 500;

/** True for a control character (newline and tab included), a single quote or a backtick: none can be written into a prompt line unescaped. */
export const hasUnsafePromptChar = (value) => /['`]/.test(value)
  || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

const GLOB_SEGMENT = /[*?[\]{}()!]/;

// The leading directory segments of a glob that contain no glob syntax (`src/checkout/**` -> ['src', 'checkout']).
const literalPrefix = (glob) => {
  const segments = glob.trim().replace(/^\.\//, '').split('/').filter(Boolean);
  const end = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
  return end === -1 ? segments : segments.slice(0, end);
};

// `**`, `**/*` and `*/**` cover every path in the repository, so they contain (or are contained by) any other path.
const coversRepository = (glob) => glob.trim().split('/').filter(Boolean).every((segment) => segment === '**' || segment === '*');

const nests = (a, b) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length > 0 && short.every((segment, index) => segment === long[index]);
};

/**
 * The first P3 path that contains, or sits inside, a P0 or P2 path, as an error message, or null when none does. A glob with no literal
 * directory prefix (`**\/*.snap`) is not compared: it is a deliberate file-type exclusion, not a directory claim. A glob that matches the
 * whole repository (`**`, `**\/*`), on either side, conflicts with every path on the other.
 * @param {{ label: string, paths: string[], priority: string }[]} entries
 */
export function auditPathConflict(entries) {
  const isP3 = (entry) => entry.priority === 'P3';
  const raised = entries.filter((entry) => entry.priority === 'P0' || entry.priority === 'P2');
  for (const dormant of entries.filter(isP3)) {
    for (const dormantPath of dormant.paths) {
      for (const other of raised) {
        const otherPath = other.paths.find((path) => coversRepository(dormantPath) || coversRepository(path) || nests(literalPrefix(dormantPath), literalPrefix(path)));
        if (otherPath) {
          return `"${dormant.label}" (P3) path ${dormantPath} overlaps "${other.label}" (${other.priority}) path ${otherPath}; a P3 path is left out of audits, so it cannot contain or sit inside a P0 or P2 path`;
        }
      }
    }
  }
  return null;
}

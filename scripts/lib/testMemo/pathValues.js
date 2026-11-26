/**
 * The test memo's abstract path values: string, path, partial-path, tail and
 * search-path constructors, their containment (whether a variable part can
 * leave its literal prefix), and the `join`/`resolve`/`new URL`/`dirname`
 * algebra over them. Pure.
 */

import { posix } from 'node:path';
import { isShippedMigrationName } from '../migrationFiles.js';
import { PATH_WITHIN_MODULES, VARIABLE_VALUES_LIMIT } from './constants.js';

export const UNKNOWN = Object.freeze({ k: 'unknown' });
export const EXTERNAL = Object.freeze({ k: 'ext' });
/** A path under the user's home directory: machine-local state, never a repository input. */
export const HOME = Object.freeze({ k: 'home' });
export const NODE = Object.freeze({ k: 'node' });
/**
 * `delimiter` imported from node's `path`: `:` or `;`, never a path separator.
 * `${dir}${delimiter}${rest}` puts `dir` on a search path (`PATH`) and ends it
 * there, so what follows is another entry (`searchPath`), not more of `dir`.
 */
export const DELIMITER = Object.freeze({ k: 'delimiter' });
/** A search-path string: each entry a directory whose programs may be found and run (`record`). */
const searchPath = (entries, tail = str('')) => ({ k: 'search', entries, tail });
export const str = (v) => ({ k: 'str', v });
export const normalizeRel = (value) => {
  // `new URL('../../', import.meta.url)` normalizes to './': the root is '' however it was spelled.
  const normalized = posix.normalize(value).replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
};
export const pathValue = (v, extra = {}) => ({ k: 'path', v: normalizeRel(v), partial: false, isDir: false, ...extra });
export const dirValue = (v) => pathValue(v, { isDir: true });
export const unfollowedReason = (value) => `reads a path the analyzer cannot follow through ${value.unfollowed}`;
export const openReadReason = (rel, via) => via == null
  ? `reads a path with a variable segment that can leave ${rel || '<repo root>'}`
  : `reads a path through ${via}() that the analyzer cannot resolve (under ${rel || '<repo root>'})`;

/**
 * A path with a variable part (`partial`) names only its literal prefix `v`.
 * Whether a read of it can land outside that prefix is its containment:
 *
 * - `open: false`: every variable part is a directory-entry name (`LISTED_NAME`)
 *   or went through `pathWithin()`, so the path is inside `v`.
 * - `open: true` with `vars`: each variable part is a parameter or loop
 *   variable with a known set of literal values (`Binder.domain`); the
 *   expression is evaluated again once per combination, exactly.
 * - `open: true` with `vars: null`: nothing bounds it. `via` names the helper
 *   whose parameter it is, for the reason a test is refused with.
 *
 * `trust` lists what a contained path took on trust: `fs` (a directory
 * listing), `crypto` (`randomUUID`), `guard` (`pathWithin`). A member of the
 * closure that mocks one of them takes the proof away (`gather`).
 */
const CONTAINED = Object.freeze({ open: false, vars: null, via: null, trust: Object.freeze([]), filter: null });
export const UNBOUNDED = Object.freeze({ open: true, vars: null, via: null, trust: Object.freeze([]), filter: null });
const containmentOf = ({ open, vars = null, via = null, trust = [], filter = null }) => (open ? { open, vars, via, trust: [], filter: null } : { ...CONTAINED, trust, filter });
/** Two variable parts in one path: inside only when both are; resolvable only when both are. */
function bothContainments(a, b) {
  if (!a.open && !b.open) return { ...CONTAINED, trust: [...new Set([...(a.trust ?? []), ...(b.trust ?? [])])], filter: a.filter ?? b.filter ?? null };
  if (!a.open) return containmentOf(b);
  if (!b.open) return containmentOf(a);
  const vars = a.vars === null || b.vars === null ? null : [...a.vars, ...b.vars.filter((binder) => !a.vars.includes(binder))];
  return { open: true, vars, via: a.via ?? b.via, trust: [], filter: null };
}
export const partialPath = (base, v, containment) => ({ ...base, v: normalizeRel(v), partial: true, sep: false, ...containmentOf(containment) });
export const unfollowedPath = (value, member) => value.unfollowed ? value : { ...partialPath(value, value.v, UNBOUNDED), unfollowed: member };
/**
 * A partial path under the literal directories of unknown text: `lit/${x}`
 * joined to `base` is under `base/lit`. `outer` keeps `base`, the prefix
 * such a path was keyed with before its literal directories were read: where
 * nothing bounds the variable part neither directory is proven, so where
 * such a path is not refused (the recorded key of a variable `import()`) both
 * are keyed rather than a narrower guess, and related selection reaches both.
 */
function underLiteral(base, baseDir, piece, containment = piece) {
  const dir = piece.lit.slice(0, piece.lit.lastIndexOf('/') + 1);
  const under = partialPath(base, posix.join(baseDir, dir), containment);
  return dir === '' ? under : { ...under, outer: normalizeRel(baseDir) };
}

/**
 * Text that starts with the literal `lit` and continues with something the
 * source does not spell out: `\`../fixtures/${name}\``, `name + '.json'`. `post`
 * is the literal text written after the last unknown piece. Containment as
 * for a partial path, read for the unknown pieces only.
 */
const tailValue = (lit, containment = UNBOUNDED, post = '') => ({ k: 'tail', lit, post, ...containmentOf(containment) });
/**
 * Text that cannot climb out of a directory: an unchanged entry name from a
 * directory listing (never empty, `.` or `..`, and with no `..` segment even
 * from a recursive listing) or a generated id (`randomUUID()`). Joined under
 * a directory it stays inside it, and so does any run of such names.
 */
const isDbMigrationFile = (name) => /\.(sql|js)$/.test(name) && !name.endsWith('.test.js') && !name.startsWith('_');
export const LISTED_NAME = Object.freeze(tailValue('', { open: false, trust: ['fs'] }));
// The scanner validates its own output, including entries returned by mocked fs.
export const MIGRATION_LISTED_NAME = Object.freeze(tailValue('', { open: false, filter: isShippedMigrationName }));
export const DB_MIGRATION_LISTED_NAME = Object.freeze(tailValue('', { open: false, trust: ['fs'], filter: isDbMigrationFile }));
export const GENERATED_NAME = Object.freeze(tailValue('', { open: false, trust: ['crypto'] }));
/** Literal text that can climb out of a directory when it follows a variable part: a `..` segment, under either separator. */
export const CLIMBS = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
/** A parameter or loop variable the source never spells out (`identifierValue`): unknown, with the containment a path built from it gets. */
export const variableValue = (containment) => ({ k: 'unknown', ...containmentOf(containment) });
/** A value that is not a literal, as unknown text: `ext`, `home` and a plain `unknown` bound nothing. */
const asTail = (value) => (value.k === 'tail' ? value : tailValue('', value.k === 'unknown' && value.open ? value : UNBOUNDED));
/** Unknown text or a variable: the kinds a later operator turns into something else. */
export const isVariableText = (value) => value.k === 'tail' || (value.k === 'unknown' && value.open === true);

/** `tail` followed by literal text or by another unknown piece. */
function extendTail(tail, next) {
  if (next.k === 'str') {
    const post = tail.post + next.v;
    // Text after a listed name keeps it inside unless it climbs: `name + '/../../x'`.
    return tailValue(tail.lit, !tail.open && CLIMBS.test(post) ? UNBOUNDED : tail, post);
  }
  const piece = asTail(next);
  const head = piece.lit === '' ? tail : extendTail(tail, str(piece.lit));
  return tailValue(head.lit, bothContainments(head, piece), piece.post);
}

/**
 * One more segment on a path that already has a variable part, or text
 * `glued` onto its last segment. `post` is the literal text since the last
 * variable piece, judged as it accumulates: `'/.' + './x'` climbs though
 * neither piece does.
 */
function joinPartial(base, segment, glued = false) {
  const before = `${base.post ?? ''}${glued ? '' : '/'}`;
  if (glued && base.maybeSelf && !base.open && (base.post ?? '') === '') return partialPath(base, base.v, UNBOUNDED);
  if (segment.k === 'str') {
    const post = before + segment.v;
    // A resolvable path is evaluated again in full, so only a contained one can be lost here.
    const climbs = !base.open && (CLIMBS.test(post) || (!glued && segment.v.startsWith('/')));
    return { ...partialPath(base, base.v, climbs ? UNBOUNDED : base), post };
  }
  // `resolve(partial, ROOT)` restarts at ROOT; an external or home segment is unknown text.
  const piece = segment.k === 'path' ? tailValue('') : asTail(segment);
  const climbs = CLIMBS.test(before + piece.lit) || (!glued && piece.lit.startsWith('/'));
  return { ...partialPath(base, base.v, bothContainments(base, climbs && !piece.open ? UNBOUNDED : piece)), post: piece.post };
}

function joinPath(base, segment) {
  if (base.unfollowed || segment.unfollowed) return base.unfollowed ? base : segment;
  if (base.partial) return joinPartial(base, segment);
  if (segment.k === 'str') {
    if (segment.v.startsWith('/')) return EXTERNAL;
    const leaf = posix.basename(segment.v);
    const isDir = segment.v.endsWith('/') || leaf === '..' || leaf === '.' || (base.isDir && !/\.[A-Za-z0-9]+$/.test(leaf));
    return pathValue(posix.join(base.v, segment.v), { isDir });
  }
  if (segment.k === 'path') return segment;
  if (segment.k === 'ext') return EXTERNAL;
  const piece = asTail(segment);
  // A leading slash restarts `resolve()` at the filesystem root and is a plain segment to `join()`;
  // a Windows separator in the literal part can spell a climb this reading does not see.
  if (piece.lit.startsWith('/') || (!piece.open && piece.lit.includes('\\'))) return partialPath(base, base.v, UNBOUNDED);
  return { ...underLiteral(base, base.v, piece), post: piece.post };
}

/**
 * Text appended to a path, as string concatenation has it. `${dir}/x` and
 * `dir + '/x'` join (the separator belongs to the join, not to an absolute
 * path), and so does text after a path that ends in a separator. Anything
 * else continues the last segment: `${file}.bak`, `${dir}/${stem}.json`.
 */
function appendPath(base, text) {
  if (text === '') return base;
  let appended;
  if (base.partial) appended = joinPartial(base, str(text.replace(/^\/+/, '')), !(text.startsWith('/') || base.sep));
  else if (text.startsWith('/') || base.sep) appended = joinPath(base, str(text.replace(/^\/+/, '')));
  // Glued onto the repository root's own name, the text names a sibling of the repository.
  else if (base.v === '') return EXTERNAL;
  else {
    const glued = base.v + text;
    appended = pathValue(glued, { isDir: text.endsWith('/') || (base.isDir && !/\.[A-Za-z0-9]+$/.test(posix.basename(glued))) });
  }
  // `${dir}/` ends in a separator, so what follows is a new segment.
  return text.endsWith('/') && appended.k === 'path' ? { ...appended, sep: true } : appended;
}

export function concatValue(left, right) {
  if (left.k === 'search') {
    if (right.k === 'delimiter') return searchPath([...left.entries, left.tail]);
    if (right.k === 'search') {
      const [head, ...rest] = right.entries;
      return searchPath([...left.entries, concatValue(left.tail, head), ...rest], right.tail);
    }
    return searchPath(left.entries, concatValue(left.tail, right));
  }
  if (right.k === 'delimiter') return left.k === 'path' ? searchPath([left]) : UNKNOWN;
  if (left.unfollowed || right.unfollowed) return left.unfollowed ? left : right;
  if (left.k === 'str' && right.k === 'str') return str(left.v + right.v);
  if (left.k === 'str' && left.v === '') return right;
  if (left.k === 'path') {
    if (right.k === 'str') return appendPath(left, right.v);
    // `${DIR}/${name}` is a join. `${DIR}${name}` glues unknown text onto the last segment and may name a
    // sibling of DIR. (An external segment keeps its older reading, in `joinPath`: outside the repository.)
    if (left.partial) return joinPartial(left, right, !left.sep);
    return left.sep || right.k === 'ext' ? joinPath(left, right) : partialPath(left, left.v, UNBOUNDED);
  }
  if (left.k === 'ext' || left.k === 'home') return left;
  if (right.k === 'path') return UNKNOWN;
  if (left.k === 'str') return extendTail(tailValue(left.v, CONTAINED), right);
  if (isVariableText(left)) return extendTail(asTail(left), right);
  return UNKNOWN;
}

/**
 * The path `new URL(spec, <a file under baseDir>)` names, by the URL parser's
 * own rules: `%20` is a space, `?raw` and `#x` are not part of the path, `\`
 * is a separator. A URL that names a directory serializes with a trailing
 * separator (`sep`).
 */
function fileUrlPath(baseDir, spec) {
  const ROOT = '/-repository-root-/';
  let url;
  try { url = new URL(spec, `file://${ROOT}${baseDir === '' ? '' : `${baseDir.split('/').map(encodeURIComponent).join('/')}/`}`); } catch { return UNKNOWN; }
  if (url.protocol !== 'file:' || url.host !== '') return EXTERNAL;
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { return UNKNOWN; }
  // Above the stand-in root is above the repository: outside it, as a `../` join is.
  const rel = path.startsWith(ROOT) ? path.slice(ROOT.length) : `../${path.replace(/^\/+/, '')}`;
  return pathValue(rel, { isDir: spec.endsWith('/'), sep: path.endsWith('/') });
}

export function urlValue(args) {
  const unfollowed = args.find((arg) => arg.unfollowed);
  if (unfollowed) return unfollowed;
  if (args.length === 0) return UNKNOWN;
  if (args.length === 1) {
    const only = args[0];
    if (only.k !== 'path') return only.k === 'str' && /^[a-z]+:/i.test(only.v) ? EXTERNAL : only.k === 'ext' ? EXTERNAL : UNKNOWN;
    if (only.partial) return only.open ? only : partialPath(only, only.v, UNBOUNDED);
    // `new URL(href + '/' + name)` parses `?raw` and `%20` out of the text, `new URL(pathToFileURL(file))`
    // keeps a `#` that is part of the name: which one this is, the path does not say.
    return /[?#%\\\s]/.test(only.v) ? partialPath(dirValue(posix.dirname(only.v)), posix.dirname(only.v), UNBOUNDED) : only;
  }
  const [spec, base] = args;
  if (base.k === 'ext' || base.k === 'home') return base;
  if (base.k !== 'path') return UNKNOWN;
  const elsewhere = (text) => /^[a-z]+:/i.test(text) || text.startsWith('/');
  if (spec.k === 'str' && elsewhere(spec.v)) return EXTERNAL;
  if (spec.k === 'path') return spec;
  // A URL decodes `%2e%2e` and reads `\` as a separator, so not even a listed name is provably inside.
  const piece = spec.k === 'str' ? null : asTail(spec);
  const unlisted = piece === null || piece.open ? piece : UNBOUNDED;
  if (base.partial) {
    // A resolvable base is evaluated again in full. A contained one is not contained any more: the spec
    // resolves beside its last segment, and the parser has its own ways to spell a climb.
    if (!base.open) return partialPath(base, base.v, UNBOUNDED);
    return partialPath(base, base.v, bothContainments(base, spec.k === 'str' ? CONTAINED : unlisted));
  }
  // Against a base that ends in a separator a spec resolves inside it, against any other beside it.
  const baseDir = base.sep ? base.v : posix.dirname(base.v);
  if (spec.k === 'str') return fileUrlPath(baseDir, spec.v);
  if (elsewhere(piece.lit)) return EXTERNAL;
  // The literal directories of the spec are kept: `new URL(\`../fixtures/${name}\`, here)` is under ../fixtures.
  return underLiteral(dirValue(baseDir), baseDir, piece, unlisted);
}

export function dirnameValue(value) {
  if (value.k !== 'path') return value.k === 'ext' ? EXTERNAL : UNKNOWN;
  // The parent of a contained path may be the prefix's own parent (`dirname` twice, or once on a guard
  // that returned its directory). A resolvable one is evaluated again in full.
  if (value.partial) return value.open ? value : partialPath(value, value.v, UNBOUNDED);
  return dirValue(posix.dirname(value.v));
}

const isProvenAbsolute = (arg) => (arg.k === 'path' && !arg.unfollowed) || (arg.k === 'str' && arg.v.startsWith('/'));

/** `join(...args)`, or `resolve(...args)` when `joins` is false: only `join` keeps a trailing separator. */
export function foldJoin(args, joins = true) {
  // `join()` reads a leading separator as a plain segment; `resolve()` restarts at the rightmost proven absolute anchor.
  let segments = args;
  if (joins) {
    segments = args.map((arg, i) => (i > 0 && arg.k === 'str' ? str(arg.v.replace(/^\/+/, '')) : arg));
  } else {
    const anchor = args.findLastIndex(isProvenAbsolute);
    if (anchor > 0) segments = args.slice(anchor);
  }
  const folded = foldSegments(segments);
  if (folded.k !== 'path' || folded.partial) return folded;
  const last = args.at(-1);
  const sep = joins && (args.length === 1 ? folded.sep === true : last.k === 'str' && last.v.endsWith('/'));
  return { ...folded, sep };
}

function foldSegments(args) {
  if (args.length === 0) return UNKNOWN;
  const unfollowed = args.find((arg) => arg.unfollowed);
  if (unfollowed) return unfollowed;
  let acc = args[0];
  if (acc.k === 'str' && acc.v.startsWith('/')) acc = EXTERNAL;
  for (const arg of args.slice(1)) {
    if (acc.k === 'str') {
      if (arg.k === 'str') acc = str(posix.join(acc.v, arg.v));
      else if (arg.k === 'path') acc = arg;
      else return UNKNOWN;
      continue;
    }
    if (acc.k !== 'path') return acc.k === 'ext' || acc.k === 'home' ? acc : UNKNOWN;
    acc = joinPath(acc, arg);
  }
  return acc;
}

export const isCryptoModule = (spec) => spec === 'crypto' || spec === 'node:crypto';
/** `spec`, written in `fileRel`, names the guard module, with or without its extension. */
export const isGuardModule = (fileRel, spec) => spec.startsWith('.') && PATH_WITHIN_MODULES.has(
  normalizeRel(posix.join(posix.dirname(fileRel), spec.endsWith('.js') ? spec : spec + '.js'))
);

/**
 * `pathWithin(dir, ...segments)`: the call throws unless the joined path is
 * inside `dir`, so a run that passed read nothing outside it, whatever the
 * segments were. Literal segments still resolve exactly.
 */
export function guardedJoin(args) {
  const [dir, ...segments] = args;
  if (dir?.k !== 'path') return UNKNOWN;
  if (dir.partial) return dir; // inside the real directory, which is wherever the partial path says it is
  // `maybeSelf`: with an empty segment the result is the directory itself, so text glued onto it names a sibling.
  // A segment with an unfollowed transform (such as slash normalization) is re-bounded to `dir` here.
  if (!segments.every((segment) => segment.k === 'str')) return { ...partialPath({ ...dir, isDir: true }, dir.v, { open: false, trust: ['guard'] }), maybeSelf: true };
  // `join()` semantics: a leading separator is a plain segment.
  return segments.reduce((path, segment) => joinPath(path, str(segment.v.replace(/^\/+/, ''))), dir);
}

/** The elements of an array are directory-entry names (`LISTED_NAME`); a finite set is a `string[]`. */
export const LISTED = Object.freeze({ listed: true });
export const MIGRATION_LISTED = Object.freeze({ listed: true, filter: isShippedMigrationName });
export const DB_MIGRATION_LISTED = Object.freeze({ listed: true, filter: isDbMigrationFile });
export const isListedDomain = (domain) => domain === LISTED || domain === MIGRATION_LISTED || domain === DB_MIGRATION_LISTED;

/** One `binder -> text` map per combination of the variables' values, or null when there is no finite set or too many. */
export function variableCombinations(vars) {
  if (vars === null || vars.reduce((count, binder) => count * binder.domain.length, 1) > VARIABLE_VALUES_LIMIT) return null;
  return vars.reduce((all, binder) => all.flatMap((chosen) => binder.domain.map((text) => new Map([...chosen, [binder, text]]))), [new Map()]);
}

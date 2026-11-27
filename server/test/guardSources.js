/**
 * The shared source helpers the server structural guard checks read through
 * (#16996): the same answers as `lib/testHelper.js`'s walkers and `lib/sourceScan.js`'s
 * lexers, computed once per runner process over `scripts/lib/guardCorpus.js`
 * instead of once per check. Every function here is a pure drop-in: a walk keeps
 * its exact inclusion rules, and a lexed text is memoized by its input.
 *
 * Each call returns a fresh array, so a check that sorts or filters in place
 * cannot change what the next check sees.
 */
import { join } from 'node:path';
import { guardCorpus, parseGuardSource } from '../../scripts/lib/guardCorpus.js';
import { SERVER_DIR, collectServerSources as walkServerSources } from '../lib/testHelper.js';
import { blankComments as lexComments, blankLiterals as lexLiterals } from '../lib/sourceScan.js';

export { SERVER_DIR };

/** `collectServerSources(dir)`, walked once per directory. */
export const collectServerSources = (dir = SERVER_DIR) => [...guardCorpus().derive('collectServerSources', dir, () => walkServerSources(dir))];
/** `readServerSource(rel)`, read once. */
export const readServerSource = (rel) => guardCorpus().read(join(SERVER_DIR, rel));

// One lex per source serves every mode: lib/sourceScan.js documents the paired
// `includeCommentOnly` result's `code` as blankCommentBodies(src) and its
// `blanked` as the default blankLiterals(src). Keyed by the source string itself:
// corpus reads hand every check the same string, whose hash V8 computes once.
const views = (src) => guardCorpus().derive('lexViews', src, () => lexLiterals(src, { includeCommentOnly: true }));
/** `blankLiterals(src, options)` from lib/sourceScan.js, lexed once per input; the paired form is a fresh object. */
export const blankLiterals = (src, { keepLiteralText = false, includeCommentOnly = false } = {}) => {
  if (includeCommentOnly) return { ...views(src) };
  return keepLiteralText ? views(src).code : views(src).blanked;
};
/** `blankCommentBodies(src)` from lib/sourceScan.js, lexed once per input. */
export const blankCommentBodies = (src) => views(src).code;
/** `blankComments(src)` from lib/sourceScan.js: a fresh copy of the once-split lines, which callers may mutate. */
export const blankComments = (src) => [...guardCorpus().derive('blankComments', src, () => lexComments(src))];

export const SOCKET_SERVER_HANDLES = new Set(['io', 'ioInstance', 'boundIo', 'providersIo', 'ioRef', 'ns']);
const SOCKET_RECEIVER = new RegExp(`\\b(?:${[...SOCKET_SERVER_HANDLES, 'getIo'].join('|')})\\b`);
const JSON_AST_CANDIDATE = /readJSONFile|safeJSONParse|atomicWrite|writeSecureJson|\\u/;

// Keep the prefilters shared so a new consumer cannot silently cause a reparse.
export const mayHaveSocketBroadcast = (source) =>
  /\\[ux]/.test(source) || (source.includes('emit') && SOCKET_RECEIVER.test(source));
export const mayHavePm2LogRead = (source) => source.includes('getLogs') || source.includes('\\u');

/** Retain ASTs only for sources that more than one guard can visit. */
export function parseRuntimeAst(path, source = guardCorpus().read(path)) {
  return JSON_AST_CANDIDATE.test(source) || mayHaveSocketBroadcast(source) || mayHavePm2LogRead(source)
    ? guardCorpus().parseAst(path) : parseGuardSource(source);
}

/** Consumers that used strict Babel parsing must also reject recovered errors. */
export function parseStrictRuntimeAst(path, source) {
  const ast = path === null ? parseGuardSource(source) : parseRuntimeAst(path, source);
  if (ast.errors.length) throw ast.errors[0];
  return ast;
}

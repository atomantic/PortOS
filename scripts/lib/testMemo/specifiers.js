/**
 * Module specifier helpers for the test memo: relative resolution mirroring
 * Vite's extensionless and directory-index lookup, the package a bare
 * specifier names, and whether it is a Node builtin. Pure.
 */

import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { RESOLVE_EXTENSIONS, RESOLVE_INDEXES } from './constants.js';

const BUILTINS = new Set(builtinModules);

/**
 * Resolve a specifier relative to the importing file, mirroring Vite's
 * extensionless and directory-index resolution. Returns the repo-relative
 * posix path of an existing file, or null.
 */
export function resolveRelativeSpecifier(fromRel, spec, kindOf) {
  const clean = spec.replace(/[?#].*$/, '');
  const target = posix.normalize(posix.join(posix.dirname(fromRel), clean));
  if (target.startsWith('../') || target === '..') return null;
  const candidates = [target, ...RESOLVE_EXTENSIONS.map((ext) => target + ext), ...RESOLVE_INDEXES.map((index) => target + index)];
  return candidates.find((candidate) => kindOf(candidate) === 'file') ?? null;
}

/** The package name a bare specifier reaches: `@scope/name` or `name`. */
export function packageNameOf(spec) {
  const clean = spec.replace(/[?#].*$/, '');
  const parts = clean.split('/');
  return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export const isBuiltin = (spec) => spec.startsWith('node:') || BUILTINS.has(packageNameOf(spec));

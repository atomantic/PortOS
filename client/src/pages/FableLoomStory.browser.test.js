import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = resolve(REPO_ROOT, 'client/src/pages/FableLoomStory.jsx');
const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const importSpecifiers = (source) => [
  ...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm),
  ...source.matchAll(/^\s*export\s+(?:\*|{)[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm),
  ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
].map((match) => match[1]);

const resolveSourceImport = (fromFile, specifier) => {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = extname(base)
    ? [base]
    : [
      ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
    ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
};

const browserBuiltinImports = (entry) => {
  const visited = new Set();
  const findings = [];
  const pending = [entry];

  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (BUILTINS.has(specifier)) {
        findings.push(`${relative(REPO_ROOT, file)} imports ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const importedFile = resolveSourceImport(file, specifier);
      if (!importedFile) {
        findings.push(`${relative(REPO_ROOT, file)} has an unresolvable relative import ${specifier}`);
      } else if (SOURCE_EXTENSIONS.includes(extname(importedFile))) {
        pending.push(importedFile);
      }
    }
  }

  return { findings: findings.sort(), visited };
};

describe('FableLoomStory browser dependency boundary', () => {
  it('keeps the route import graph free of Node builtins', () => {
    const { findings, visited } = browserBuiltinImports(ENTRY);
    expect(findings).toEqual([]);
    const reached = [...visited].map((file) => relative(REPO_ROOT, file));
    expect(reached).toEqual(expect.arrayContaining([
      'server/lib/fableLoomOutline.js',
      'server/lib/textUtils.js',
    ]));
  });
});

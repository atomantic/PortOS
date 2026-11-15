/**
 * The names a module namespace exposes, derived from source instead of by
 * importing it. `Object.keys(await import(file))` is the ground truth for what a
 * barrel exports, but importing `cos.js` transforms its entire service graph
 * (seconds, on every always-run guard). ES module export forms are fully static,
 * so a parse yields the same key set: declarations, `export { a as b }` with or
 * without `from`, `export * as ns`, `export default`, and `export * from`
 * followed recursively.
 *
 * A star re-export of a bare package cannot be followed from here, so it throws
 * rather than leaving a hole a guard would read as "nothing forwarded".
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { parse } from '@babel/parser';

const moduleName = (node) => node.type === 'Identifier' ? node.name : node.value;

function declaredNames(declaration) {
  if (!declaration) return [];
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap(({ id }) => patternNames(id));
  }
  return declaration.id ? [declaration.id.name] : [];
}

function patternNames(pattern) {
  switch (pattern.type) {
    case 'Identifier': return [pattern.name];
    case 'ObjectPattern': return pattern.properties.flatMap((prop) => patternNames(prop.value ?? prop.argument));
    case 'ArrayPattern': return pattern.elements.filter(Boolean).flatMap(patternNames);
    case 'AssignmentPattern': return patternNames(pattern.left);
    case 'RestElement': return patternNames(pattern.argument);
    default: return [];
  }
}

/** Sorted export names of the module at absolute path `file`. */
export function staticExportNames(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', errorRecovery: false });
  const names = new Set();
  for (const node of ast.program.body) {
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    else if (node.type === 'ExportNamedDeclaration') {
      for (const name of declaredNames(node.declaration)) names.add(name);
      for (const specifier of node.specifiers) names.add(moduleName(specifier.exported));
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exported) { names.add(moduleName(node.exported)); continue; }
      const spec = node.source.value;
      if (!spec.startsWith('.')) throw new Error(`${file}: cannot follow \`export * from '${spec}'\` statically`);
      for (const name of staticExportNames(resolve(dirname(file), spec), seen)) {
        if (name !== 'default') names.add(name);
      }
    }
  }
  return [...names].sort();
}

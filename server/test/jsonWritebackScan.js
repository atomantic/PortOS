import { parse } from '@babel/parser';

// Test-only syntax scan, never imports a service or reads runtime data.
// Matches direct helper names (including imported aliases), not arbitrary
// wrappers, namespace calls, variable aliases, or cross-module dataflow.
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return; }
  if (node.type) visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'extra', 'tokens', 'comments'].includes(key)) walk(child, visit);
  }
}

// Only a final, statically true strict property proves strictness. A later
// spread/computed key might override it, so unknown options remain candidates.
function isStrict(options) {
  if (options?.type !== 'ObjectExpression') return false;
  let strict = false;
  for (const property of options.properties) {
    if (property.type === 'SpreadElement' || property.computed) strict = false;
    else if ((property.key.name ?? property.key.value) === 'strict') {
      strict = property.value?.type === 'BooleanLiteral' && property.value.value;
    }
  }
  return strict;
}

function expressionKey(node, tokens, source) {
  return tokens.filter(token => token.start >= node.start && token.end <= node.end
    && token.type.label && token.type.label !== 'eof')
    .map(token => token.type.label === 'string' ? JSON.stringify(token.value)
      : source.slice(token.start, token.end)).join(' ');
}

/** Same-module first-argument syntax equality; no control-flow proof implied. */
export function scanJsonWriteback(source) {
  const ast = parse(source, { sourceType: 'module', tokens: true });
  const names = new Map(['readJSONFile', 'readJSONFileStrict', 'atomicWrite'].map(name => [name, name]));
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && names.has(specifier.imported.name)) {
        names.set(specifier.local.name, specifier.imported.name);
      }
    }
  }
  const reads = new Set();
  const strictReads = new Set();
  const writes = new Set();
  walk(ast.program, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !node.arguments[0]) return;
    const name = names.get(node.callee.name);
    if (!name) return;
    const key = expressionKey(node.arguments[0], ast.tokens, source);
    if (name === 'atomicWrite') writes.add(key);
    else if (name === 'readJSONFileStrict' || isStrict(node.arguments[2])) strictReads.add(key);
    else reads.add(key);
  });
  return {
    candidates: [...reads].filter(key => writes.has(key)).sort(),
    strict: [...strictReads].filter(key => writes.has(key)).sort(),
  };
}

export function reconcileJsonWriteback(candidates, exceptions) {
  const keys = new Set(candidates);
  const allowed = new Set(exceptions.map(entry => entry.key));
  return {
    unclassified: [...keys].filter(key => !allowed.has(key)).sort(),
    stale: [...allowed].filter(key => !keys.has(key)).sort(),
  };
}

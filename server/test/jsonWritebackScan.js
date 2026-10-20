import { parse } from '@babel/parser';

// A cheap, conservative caller gate: aliases retain the imported helper name.
// Unicode escapes may spell an identifier without its literal name, so those
// sources still get parsed. Comments/strings are harmless false positives.
// `safeJSONParse` admits the lenient raw-read shape (#12440).
export function mayReadJsonFile(source) {
  return source.includes('readJSONFile') || source.includes('safeJSONParse') || source.includes('\\u');
}

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

const FUNCTION_NODES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']);

// Pre-order walk that also reports leaving a function, so callers can keep
// per-function variable bindings (closures resolve through the stack).
function walkScoped(node, enter, leave) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walkScoped(child, enter, leave)); return; }
  if (node.type) enter(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'extra', 'tokens', 'comments'].includes(key)) walkScoped(child, enter, leave);
  }
  if (node.type) leave(node);
}

// Identifiers read as variables: not `.property` names or non-computed object keys.
function referencedNames(node, names = []) {
  if (!node || typeof node !== 'object') return names;
  if (Array.isArray(node)) { node.forEach(child => referencedNames(child, names)); return names; }
  if (node.type === 'Identifier') names.push(node.name);
  else if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    referencedNames(node.object, names);
    if (node.computed) referencedNames(node.property, names);
  } else if (node.type === 'ObjectProperty' && !node.computed) referencedNames(node.value, names);
  else {
    for (const [key, child] of Object.entries(node)) {
      if (!['loc', 'extra', 'tokens', 'comments'].includes(key)) referencedNames(child, names);
    }
  }
  return names;
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
  const names = new Map(['readJSONFile', 'readJSONFileStrict', 'atomicWrite', 'tryReadFile', 'readFile', 'safeJSONParse'].map(name => [name, name]));
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
  const calleeName = node => node.type === 'CallExpression' && node.callee.type === 'Identifier'
    ? names.get(node.callee.name) : undefined;
  const rawReadsIn = expression => {
    const keys = [];
    walk(expression, node => {
      const name = calleeName(node);
      if ((name === 'tryReadFile' || name === 'readFile') && node.arguments[0]) {
        keys.push(expressionKey(node.arguments[0], ast.tokens, source));
      }
    });
    return keys;
  };
  // `tryReadFile`/`readFile` collapse unreadable into absent (or throw) and
  // `safeJSONParse` swallows malformed text, so a raw read whose bytes reach
  // `safeJSONParse` through a variable or inline is a non-strict JSON read of
  // that path. Bindings are lexical (function parameters, blocks, declarations
  // shadow outer ones) and resolved after the walk so declaration order does not
  // matter; other dataflow is out of scope.
  const scopes = [new Map()];
  const pending = [];
  walkScoped(ast.program, node => {
    if (FUNCTION_NODES.has(node.type) || node.type === 'BlockStatement') {
      const scope = new Map();
      if (FUNCTION_NODES.has(node.type)) walk(node.params, param => { if (param.type === 'Identifier') scope.set(param.name, []); });
      scopes.push(scope);
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      scopes.at(-1).set(node.id.name, node.init ? rawReadsIn(node.init) : []);
    }
    const name = calleeName(node);
    if (!name || !node.arguments[0]) return;
    if (name === 'safeJSONParse') {
      for (const key of rawReadsIn(node.arguments[0])) reads.add(key);
      pending.push({ names: referencedNames(node.arguments[0]), chain: [...scopes] });
      return;
    }
    if (name === 'tryReadFile' || name === 'readFile') return;
    const key = expressionKey(node.arguments[0], ast.tokens, source);
    if (name === 'atomicWrite') writes.add(key);
    else if (name === 'readJSONFileStrict' || isStrict(node.arguments[2])) strictReads.add(key);
    else reads.add(key);
  }, node => {
    if (FUNCTION_NODES.has(node.type) || node.type === 'BlockStatement') scopes.pop();
  });
  for (const { names: referenced, chain } of pending) {
    for (const identifier of referenced) {
      chain.findLast(scope => scope.has(identifier))?.get(identifier).forEach(key => reads.add(key));
    }
  }
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

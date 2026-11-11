import { parse } from '@babel/parser';
import { posix } from 'node:path';

// A cheap, conservative caller gate: aliases retain the imported helper name.
// Unicode escapes may spell an identifier without its literal name, so those
// sources still get parsed. Comments/strings are harmless false positives.
// `safeJSONParse` admits the lenient raw-read shape (#12440).
export function mayReadJsonFile(source, registry = new Map()) {
  return source.includes('readJSONFile') || source.includes('safeJSONParse') || source.includes('\\u')
    || [...registry.values()].some(({ wrappers }) => [...wrappers.keys()].some(name => name === 'default'
      ? /\bimport\s+[^\s{*]/.test(source) : source.includes(name)));
}

// Test-only syntax scan, never imports a service or reads runtime data.
// Matches direct helper names (including imported aliases), not arbitrary
// namespace calls, variable aliases, or general cross-module dataflow.
// Exported direct-return wrappers resolve exactly one import hop below.
const AST_METADATA = new Set(['loc', 'extra', 'tokens', 'comments']);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return; }
  if (node.type) visit(node);
  for (const key of Object.keys(node)) {
    if (!AST_METADATA.has(key)) walk(node[key], visit);
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
  for (const key of Object.keys(node)) {
    if (!AST_METADATA.has(key)) walkScoped(node[key], enter, leave);
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
    for (const key of Object.keys(node)) {
      if (!AST_METADATA.has(key)) referencedNames(node[key], names);
    }
  }
  return names;
}

function expressionKey(node, tokens, source) {
  // Babel's tokens are ordered by source position. An argument needs only its
  // own span, not a full-module token scan for every read and write.
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tokens[middle].start < node.start) low = middle + 1;
    else high = middle;
  }
  const parts = [];
  for (let index = low; index < tokens.length && tokens[index].start <= node.end; index++) {
    const token = tokens[index];
    if (token.end > node.end || !token.type.label || token.type.label === 'eof') continue;
    parts.push(token.type.label === 'string' ? JSON.stringify(token.value) : source.slice(token.start, token.end));
  }
  return parts.join(' ');
}

const HELPER_NAMES = ['readJSONFile', 'readJSONFileStrict', 'atomicWrite', 'tryReadFile', 'readFile', 'safeJSONParse'];

function helperNames(ast) {
  const names = new Map(HELPER_NAMES.map(name => [name, name]));
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && HELPER_NAMES.includes(specifier.imported.name)) {
        names.set(specifier.local.name, specifier.imported.name);
      }
    }
  }
  return names;
}

const importedModule = (module, specifier) => posix.normalize(posix.join(posix.dirname(module), specifier));
const unawait = node => node?.type === 'AwaitExpression' ? unawait(node.argument) : node;

/** Derive direct returned reads, never follow another wrapper. */
export function buildJsonReadWrapperRegistry(modules) {
  const registry = new Map();
  for (const [module, source] of modules) {
    if (!mayReadJsonFile(source) && !source.includes('tryReadFile')) continue;
    const ast = parse(source, { sourceType: 'module' });
    const names = helperNames(ast);
    const functions = new Map();
    const constants = new Set();
    const exports = new Map();
    for (const statement of ast.program.body) {
      const declaration = statement.declaration ?? statement;
      if (declaration.type === 'FunctionDeclaration') functions.set(declaration.id?.name, declaration);
      if (declaration.type === 'VariableDeclaration') {
        for (const binding of declaration.declarations) {
          if (binding.id.type !== 'Identifier') continue;
          if (FUNCTION_NODES.has(binding.init?.type)) functions.set(binding.id.name, binding.init);
          else if (declaration.kind === 'const') constants.add(binding.id.name);
        }
      }
      if (statement.type === 'ExportNamedDeclaration') {
        if (declaration.type === 'FunctionDeclaration') exports.set(declaration.id.name, declaration.id.name);
        if (declaration.type === 'VariableDeclaration') {
          for (const binding of declaration.declarations) if (binding.id.type === 'Identifier') exports.set(binding.id.name, binding.id.name);
        }
        if (!statement.source) for (const specifier of statement.specifiers) exports.set(specifier.exported.name, specifier.local.name);
      }
      if (statement.type === 'ExportDefaultDeclaration') {
        if (FUNCTION_NODES.has(declaration.type)) functions.set('default', declaration);
        exports.set('default', declaration.type === 'Identifier' ? declaration.name : 'default');
      }
    }
    const wrappers = new Map();
    for (const [exportName, local] of exports) {
      const fn = functions.get(local);
      if (!fn) continue;
      // Nested callback returns do not return the containing wrapper's value.
      const bindings = new Map();
      const returns = fn.body.type === 'BlockStatement'
        ? fn.body.body.filter(node => node.type === 'ReturnStatement').map(node => node.argument) : [fn.body];
      if (fn.body.type === 'BlockStatement') {
        for (const statement of fn.body.body) {
          if (statement.type !== 'VariableDeclaration') continue;
          for (const binding of statement.declarations) if (binding.id.type === 'Identifier') bindings.set(binding.id.name, binding.init);
        }
      }
      const readPaths = (expression, seen = new Set(), raw = false) => {
        const node = unawait(expression);
        if (!node) return [];
        if (node.type === 'Identifier' && bindings.has(node.name) && !seen.has(node.name)) {
          return readPaths(bindings.get(node.name), new Set([...seen, node.name]), raw);
        }
        if (raw && node.type === 'LogicalExpression') return [...readPaths(node.left, seen, raw), ...readPaths(node.right, seen, raw)];
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return [];
        const name = names.get(node.callee.name);
        if (name === 'safeJSONParse') return readPaths(node.arguments[0], seen, true);
        if (name === 'readJSONFile' && !isStrict(node.arguments[2])
          || name === 'tryReadFile' || raw && name === 'readFile') return [node.arguments[0]];
        return [];
      };
      const descriptors = returns.flatMap(expression => readPaths(expression)).flatMap(path => {
        if (path?.type !== 'Identifier') return [];
        const pathParamIndex = fn.params.findIndex(param => (param.type === 'AssignmentPattern' ? param.left : param).name === path.name);
        if (pathParamIndex >= 0) return [{ pathParamIndex }];
        return constants.has(path.name) && !bindings.has(path.name) ? [{ pathKey: `${module}#${path.name}` }] : [];
      });
      if (descriptors.length) wrappers.set(exportName, descriptors);
    }
    if (wrappers.size) {
      registry.set(module, { wrappers, pathExports: new Map([...exports].filter(([, local]) => constants.has(local))) });
    }
  }
  return registry;
}

/** Same-path syntax equality plus one imported wrapper hop; no control-flow proof. */
export function scanJsonWriteback(source, { module = '', registry = new Map() } = {}) {
  const ast = parse(source, { sourceType: 'module', tokens: true });
  const names = helperNames(ast);
  const wrappers = new Map();
  const importedPaths = new Map();
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || !statement.source.value.startsWith('.')) continue;
    const target = importedModule(module, statement.source.value);
    for (const specifier of statement.specifiers) {
      const exported = specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported?.name;
      const descriptors = registry.get(target)?.wrappers.get(exported);
      if (descriptors) wrappers.set(specifier.local.name, descriptors);
      // Preserve established direct-read exception keys; canonicalize only
      // constants which actually identify registered wrapper reads.
      const constant = registry.get(target)?.pathExports.get(exported);
      if (constant && [...registry.get(target).wrappers.values()].flat().some(entry => entry.pathKey === `${target}#${constant}`)) {
        importedPaths.set(specifier.local.name, `${target}#${constant}`);
      }
    }
  }
  const pathKey = node => node.type === 'Identifier' && importedPaths.has(node.name)
    ? importedPaths.get(node.name) : expressionKey(node, ast.tokens, source);
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
        keys.push(pathKey(node.arguments[0]));
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
      if (FUNCTION_NODES.has(node.type)) walk(node.params, param => { if (param.type === 'Identifier') scope.set(param.name, null); });
      scopes.push(scope);
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      // Keep the binding even when it shadows an outer raw read, but do not
      // traverse every initializer: only a value used by safeJSONParse can
      // contribute a raw JSON read.
      scopes.at(-1).set(node.id.name, node.init);
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && wrappers.has(node.callee.name)) {
      for (const descriptor of wrappers.get(node.callee.name)) {
        const argument = node.arguments[descriptor.pathParamIndex];
        if (descriptor.pathKey) reads.add(descriptor.pathKey);
        else if (argument) reads.add(pathKey(argument));
      }
      return;
    }
    const name = calleeName(node);
    if (!name || !node.arguments[0]) return;
    if (name === 'safeJSONParse') {
      for (const key of rawReadsIn(node.arguments[0])) reads.add(key);
      pending.push({ names: referencedNames(node.arguments[0]), chain: [...scopes] });
      return;
    }
    if (name === 'tryReadFile' || name === 'readFile') return;
    const key = pathKey(node.arguments[0]);
    if (name === 'atomicWrite') writes.add(key);
    else if (name === 'readJSONFileStrict' || isStrict(node.arguments[2])) strictReads.add(key);
    else reads.add(key);
  }, node => {
    if (FUNCTION_NODES.has(node.type) || node.type === 'BlockStatement') scopes.pop();
  });
  for (const { names: referenced, chain } of pending) {
    for (const identifier of referenced) {
      const initializer = chain.findLast(scope => scope.has(identifier))?.get(identifier);
      if (initializer) rawReadsIn(initializer).forEach(key => reads.add(key));
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

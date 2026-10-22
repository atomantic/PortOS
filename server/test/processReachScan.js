/**
 * Static trace from a mounted route handler to host-process work (#13097).
 *
 * The host-control guard (server/hostControlCoverage.test.js) uses this to find
 * GET routes whose handler can start a process, drive a browser or read the
 * keychain. Matching module imports would flag nearly every route, because
 * almost every route module reaches `child_process` somewhere in its import
 * closure. The trace therefore works on module-scope bindings instead:
 *
 *   handler arguments → the module-scope bindings and imports they name
 *     → each binding's own body → … → a SINK
 *
 * Sinks: an import (or `require` / `process.getBuiltinModule`) of
 * child_process, node-pty, playwright, puppeteer, keytar or ws; a global
 * `WebSocket`; a DevTools HTTP endpoint literal (`/json/new`, `/json/list`, …);
 * an `import()` whose specifier is computed; and a dependency injected into a
 * router factory (a parameter of the function that declares the route), which
 * the trace cannot see through.
 *
 * Over-approximations, all in the direction of reporting more:
 *   - a binding is reached whole: every name its body mentions is followed,
 *     whichever branch would run it;
 *   - a module-scope name is followed even where a local shadows it;
 *   - `ns.member` on a namespace import follows `member`; any other use of the
 *     namespace follows the whole module, as does an `import()` whose result
 *     is not destructured;
 *   - `export *` barrels try every star source;
 *   - an `import()` target's top-level statements count, because the first
 *     request evaluates them.
 *
 * Not followed, so a classifier must read for them: a callback stored at
 * runtime (a setter, a Map registry) and later called through module state,
 * an EventEmitter listener registered in another module, and router-level
 * `use()` middleware.
 */
import { parse } from '@babel/parser';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const SINK_PACKAGES = new Map([
  ['child_process', 'child_process'],
  ['node:child_process', 'child_process'],
  ['node-pty', 'pty'],
  ['playwright', 'browser'],
  ['playwright-core', 'browser'],
  ['puppeteer', 'browser'],
  ['puppeteer-core', 'browser'],
  ['keytar', 'keychain'],
  ['ws', 'websocket'],
]);
// PortOS's drop-in child_process wrapper; its callers are the sites worth naming.
const SINK_MODULES = new Map([['server/lib/childProcess.js', 'child_process']]);
// DevTools HTTP endpoints: opening, listing or closing tabs in a Chrome over CDP.
const CDP_ENDPOINT_RE = /\/json\/(?:new|list|close|activate|version|protocol)\b/;
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const SKIP_KEYS = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'start', 'end', 'range']);

const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;
const isDirectory = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const resolveLocalModule = (fromFile, specifier) => {
  const candidate = resolve(dirname(fromFile), specifier.split(/[?#]/)[0]);
  if (extname(candidate) && isFile(candidate)) return candidate;
  if (isFile(`${candidate}.js`)) return `${candidate}.js`;
  if (isDirectory(candidate) && isFile(join(candidate, 'index.js'))) return join(candidate, 'index.js');
  return null;
};

const stringValue = (node) => {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

const sinkForSpecifier = (specifier) => SINK_PACKAGES.get(specifier)
  ?? SINK_PACKAGES.get(specifier?.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));

/** Names a binding pattern declares, and the expressions inside it (defaults, computed keys) that are references. */
function patternParts(pattern, names = [], expressions = []) {
  if (!pattern) return { names, expressions };
  switch (pattern.type) {
    case 'Identifier': names.push(pattern.name); break;
    case 'AssignmentPattern': patternParts(pattern.left, names, expressions); expressions.push(pattern.right); break;
    case 'RestElement': patternParts(pattern.argument, names, expressions); break;
    case 'ArrayPattern': pattern.elements.forEach((element) => patternParts(element, names, expressions)); break;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') patternParts(property.argument, names, expressions);
        else {
          if (property.computed) expressions.push(property.key);
          patternParts(property.value, names, expressions);
        }
      }
      break;
    default: expressions.push(pattern); // MemberExpression targets in assignment patterns
  }
  return { names, expressions };
}

/** Property names destructured from an `await import()` result, or null for "the whole module". */
function destructuredNames(pattern) {
  if (pattern?.type !== 'ObjectPattern') return null;
  const names = [];
  for (const property of pattern.properties) {
    if (property.type === 'RestElement' || property.computed) return null;
    names.push(property.key.name ?? property.key.value);
  }
  return names;
}

const isDynamicImport = (node) => node?.type === 'ImportExpression'
  || (node?.type === 'CallExpression' && node.callee?.type === 'Import');
const dynamicImportSource = (node) => (node.type === 'ImportExpression' ? node.source : node.arguments[0]);

/**
 * Everything one subtree refers to: `names` it mentions in reference position,
 * `namespaceMembers` read off a namespace import, `imports` it loads lazily,
 * `sinks` it touches directly, and the `declared` names it binds itself.
 */
function collectReferences(root, namespaces) {
  const names = new Set();
  const declared = new Set();
  const namespaceMembers = [];
  const memberRefs = [];
  const imports = [];
  const sinks = [];
  // Locals holding an `import()` namespace: `const mod = await import('./x.js')`
  // or `import('./x.js').then((mod) => …)`. `mod.member` loads only that member.
  const aliases = new Map();

  const declare = (pattern) => {
    const parts = patternParts(pattern);
    parts.names.forEach((name) => declared.add(name));
    parts.expressions.forEach((expression) => visit(expression));
  };

  const visitDynamicImport = (node, members) => {
    const specifier = stringValue(dynamicImportSource(node));
    if (specifier === null) sinks.push('computed-import');
    else imports.push({ specifier, members });
    (node.arguments ?? []).slice(1).forEach(visit);
    if (node.options) visit(node.options);
  };

  // `const { a } = await import('./x.js')` and `(await import('./x.js')).a` load only `a`.
  const awaitedImport = (node) => {
    const inner = node?.type === 'AwaitExpression' ? node.argument : node;
    return isDynamicImport(inner) ? inner : null;
  };

  // Bind an `import()` result to a pattern: destructured names, an alias, or the whole module.
  const bindImport = (importNode, pattern) => {
    if (pattern?.type === 'Identifier') {
      const specifier = stringValue(dynamicImportSource(importNode));
      if (specifier !== null) {
        visitDynamicImport(importNode, []);
        aliases.set(pattern.name, specifier);
        declared.add(pattern.name);
        return;
      }
    }
    visitDynamicImport(importNode, destructuredNames(pattern));
    declare(pattern);
  };

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier':
        names.add(node.name);
        return;
      case 'StringLiteral':
        if (CDP_ENDPOINT_RE.test(node.value)) sinks.push('browser');
        return;
      case 'TemplateLiteral':
        if (node.quasis.some((quasi) => CDP_ENDPOINT_RE.test(quasi.value.raw))) sinks.push('browser');
        node.expressions.forEach(visit);
        return;
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        if (node.object.type === 'Identifier' && !node.computed && node.property.type === 'Identifier') {
          const { name } = node.object;
          const member = node.property.name;
          if (aliases.has(name)) imports.push({ specifier: aliases.get(name), members: [member] });
          else if (namespaces.has(name)) namespaceMembers.push({ local: name, member });
          else memberRefs.push({ name, member });
          return;
        }
        const imported = awaitedImport(node.object);
        if (imported && !node.computed) {
          visitDynamicImport(imported, [node.property.name]);
          return;
        }
        visit(node.object);
        if (node.computed) visit(node.property);
        return;
      }
      case 'VariableDeclarator': {
        const imported = awaitedImport(node.init);
        if (imported) { bindImport(imported, node.id); return; }
        // `const [{ a }, { b }] = await Promise.all([import('./x.js'), import('./y.js')])`
        const all = node.init?.type === 'AwaitExpression' ? node.init.argument : null;
        if (node.id.type === 'ArrayPattern' && all?.type === 'CallExpression' && all.callee.type === 'MemberExpression'
          && all.callee.object.name === 'Promise' && all.callee.property.name === 'all'
          && all.arguments[0]?.type === 'ArrayExpression' && all.arguments[0].elements.every(isDynamicImport)) {
          all.arguments[0].elements.forEach((element, index) => {
            const pattern = node.id.elements[index];
            if (pattern) bindImport(element, pattern);
            else visitDynamicImport(element, []);
          });
          return;
        }
        visit(node.init);
        declare(node.id);
        return;
      }
      case 'ImportExpression':
        visitDynamicImport(node, null);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        if (isDynamicImport(node)) { visitDynamicImport(node, null); return; }
        const callee = node.callee;
        const handler = node.arguments?.[0];
        if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed
          && callee.property.name === 'then' && isDynamicImport(callee.object)
          && (handler?.type === 'ArrowFunctionExpression' || handler?.type === 'FunctionExpression')) {
          bindImport(callee.object, handler.params[0]);
          handler.params.slice(1).forEach(declare);
          visit(handler.body);
          node.arguments.slice(1).forEach(visit);
          return;
        }
        const first = stringValue(node.arguments?.[0]);
        const isRequire = callee.type === 'Identifier' && callee.name === 'require';
        const isBuiltin = (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
          && callee.object.type === 'Identifier' && callee.object.name === 'process'
          && !callee.computed && callee.property.name === 'getBuiltinModule';
        if ((isRequire || isBuiltin) && first !== null && sinkForSpecifier(first)) sinks.push(sinkForSpecifier(first));
        if (isRequire && first === null) sinks.push('computed-import');
        break;
      }
      case 'ObjectProperty':
        if (node.computed) visit(node.key);
        visit(node.value);
        return;
      case 'ObjectMethod':
      case 'ClassMethod':
      case 'ClassPrivateMethod':
        if (node.computed) visit(node.key);
        node.params.forEach(declare);
        visit(node.body);
        return;
      case 'ClassProperty':
      case 'ClassPrivateProperty':
      case 'ClassAccessorProperty':
        if (node.computed) visit(node.key);
        visit(node.value);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) declared.add(node.id.name);
        (node.params ?? []).forEach(declare);
        visit(node.superClass);
        visit(node.body);
        return;
      case 'CatchClause':
        declare(node.param);
        visit(node.body);
        return;
      case 'LabeledStatement':
        visit(node.body);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
      case 'PrivateName':
        return;
      default:
        break;
    }
    for (const [key, child] of Object.entries(node)) {
      if (!SKIP_KEYS.has(key) && key !== 'type') visit(child);
    }
  }

  visit(root);
  // An alias used other than as `alias.member` (passed on, spread, indexed) loads the whole module.
  for (const [alias, specifier] of aliases) {
    if (names.has(alias)) imports.push({ specifier, members: null });
  }
  return { names, declared, namespaceMembers, memberRefs, imports, sinks };
}

function parseModule(file) {
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, {
    sourceType: 'module',
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    createImportExpressions: true,
  });
  const imports = new Map(); // local → { specifier, imported } ('*' for a namespace)
  const bindings = new Map(); // top-level name → [node]
  const exports = new Map(); // exported name → { local } | { specifier, imported }
  const stars = [];
  const sideEffects = [];
  const addBinding = (name, node) => bindings.set(name, [...(bindings.get(name) ?? []), node]);
  const declareTop = (declaration) => {
    if (!declaration) return [];
    if (declaration.type === 'VariableDeclaration') {
      return declaration.declarations.flatMap((declarator) => {
        const { names } = patternParts(declarator.id);
        names.forEach((name) => addBinding(name, declarator));
        return names;
      });
    }
    if (declaration.id) {
      addBinding(declaration.id.name, declaration);
      return [declaration.id.name];
    }
    return [];
  };

  for (const statement of ast.program.body) {
    switch (statement.type) {
      case 'ImportDeclaration':
        for (const specifier of statement.specifiers) {
          const imported = specifier.type === 'ImportNamespaceSpecifier' ? '*'
            : specifier.type === 'ImportDefaultSpecifier' ? 'default'
              : (specifier.imported.name ?? specifier.imported.value);
          imports.set(specifier.local.name, { specifier: statement.source.value, imported });
        }
        break;
      case 'ExportNamedDeclaration':
        if (statement.declaration) {
          declareTop(statement.declaration).forEach((name) => exports.set(name, { local: name }));
        }
        for (const specifier of statement.specifiers ?? []) {
          const exported = specifier.exported.name ?? specifier.exported.value;
          if (statement.source) {
            const imported = specifier.type === 'ExportNamespaceSpecifier' ? '*' : (specifier.local.name ?? specifier.local.value);
            exports.set(exported, { specifier: statement.source.value, imported });
          } else {
            exports.set(exported, { local: specifier.local.name });
          }
        }
        break;
      case 'ExportAllDeclaration':
        if (statement.exported) exports.set(statement.exported.name, { specifier: statement.source.value, imported: '*' });
        else stars.push(statement.source.value);
        break;
      case 'ExportDefaultDeclaration': {
        const declaration = statement.declaration;
        if (declaration.type === 'Identifier') exports.set('default', { local: declaration.name });
        else if (declaration.id) {
          addBinding(declaration.id.name, declaration);
          exports.set('default', { local: declaration.id.name });
        } else {
          addBinding('*default*', declaration);
          exports.set('default', { local: '*default*' });
        }
        break;
      }
      case 'VariableDeclaration':
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        declareTop(statement);
        break;
      default:
        sideEffects.push(statement);
    }
  }
  const namespaces = new Set([...imports].filter(([, entry]) => entry.imported === '*').map(([local]) => local));
  return { file, ast, imports, bindings, exports, stars, sideEffects, namespaces };
}

/** Route-registration calls (`<router>.<method>('<path>', …handlers)`) with the functions enclosing each. */
function routeCalls(ast) {
  const calls = [];
  const walk = (node, enclosing) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child) => walk(child, enclosing)); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object.type === 'Identifier' && stringValue(node.arguments[0]) !== null) {
      calls.push({
        routerId: node.callee.object.name,
        method: node.callee.property.name,
        path: stringValue(node.arguments[0]),
        handlers: node.arguments.slice(1),
        enclosing,
      });
    }
    const next = FUNCTION_TYPES.has(node.type) ? [node, ...enclosing] : enclosing;
    for (const [key, child] of Object.entries(node)) {
      if (!SKIP_KEYS.has(key) && key !== 'type') walk(child, next);
    }
  };
  walk(ast.program, []);
  return calls;
}

/** Declarations a function makes in its own scope (params, and declarations not nested in another function). */
function functionScope(fn) {
  const params = new Set(fn.params.flatMap((param) => patternParts(param).names));
  const locals = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator') {
      patternParts(node.id).names.forEach((name) => locals.set(name, [...(locals.get(name) ?? []), node]));
    } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      locals.set(node.id.name, [...(locals.get(node.id.name) ?? []), node]);
    }
    if (FUNCTION_TYPES.has(node.type)) return;
    for (const [key, child] of Object.entries(node)) {
      if (!SKIP_KEYS.has(key) && key !== 'type') walk(child);
    }
  };
  walk(fn.body);
  return { params, locals };
}

const objectLiteral = (node) => {
  let value = node?.type === 'VariableDeclarator' ? node.init : node;
  if (value?.type === 'CallExpression' && value.callee.type === 'MemberExpression'
    && value.callee.object.name === 'Object' && value.callee.property.name === 'freeze') value = value.arguments[0];
  return value?.type === 'ObjectExpression' ? value : null;
};

/**
 * The parts of a module-scope object literal that `binding.member` can read:
 * the matching properties plus every spread and computed key. Null when the
 * binding is not one plain object literal, or no part can supply the member
 * (it was added at runtime), so the caller follows the whole binding.
 */
function memberNodes(nodes, member) {
  const object = nodes.length === 1 ? objectLiteral(nodes[0]) : null;
  if (!object) return null;
  const parts = object.properties.filter((property) => property.type === 'SpreadElement' || property.computed
    || (property.key.name ?? property.key.value) === member);
  return parts.length ? parts : null;
}

/**
 * `createProcessReachTracer({ repoRoot, reviewedSites })`. Each reviewed site
 * is a repo-relative `path#binding` that ends the trace. Returns:
 *   - `routeSinks(declaration)`: the sorted sink kinds one scanRouteGraph
 *     `declarations` entry can reach (empty when none);
 *   - `explainRoute(declaration)`: `{ sinks, chain }`, with the shortest path
 *     to a sink as `path#binding` steps, for a failure message;
 *   - `traceSite(site)`: the same for one binding, ignoring its own review, or
 *     null when the binding no longer exists.
 */
export function createProcessReachTracer({ repoRoot, reviewedSites = [] }) {
  const modules = new Map();
  const moduleFor = (file) => {
    if (!modules.has(file)) modules.set(file, parseModule(file));
    return modules.get(file);
  };
  const repoPath = (file) => relative(repoRoot, file).split(sep).join('/');
  const keyLabel = (key) => {
    const at = key.lastIndexOf('#');
    return `${repoPath(key.slice(0, at))}#${key.slice(at + 1)}`;
  };
  const labelKey = (siteLabel) => {
    const at = siteLabel.lastIndexOf('#');
    return `${join(repoRoot, siteLabel.slice(0, at))}#${siteLabel.slice(at + 1)}`;
  };
  const reviewedKeys = new Set(reviewedSites.map(labelKey));
  const referenceCache = new WeakMap();

  // Targets one import specifier names: a relative module's export, or a sink.
  const importTargets = (fromFile, specifier, imported) => {
    const sink = sinkForSpecifier(specifier);
    if (sink) return [{ sink }];
    if (!specifier.startsWith('.')) return [];
    const file = resolveLocalModule(fromFile, specifier);
    if (!file || !/\.[cm]?js$/.test(file)) return [];
    if (SINK_MODULES.has(repoPath(file))) return [{ sink: SINK_MODULES.get(repoPath(file)) }];
    return imported === '*' ? [{ file, name: '*' }] : [{ file, name: imported }];
  };

  // An exported name resolved to the nodes that declare it, through re-exports and stars.
  // `viaStar` is set while searching `export *` sources, where a module that
  // lacks the name is simply not the one providing it.
  const exportTargets = (file, name, seen = new Set(), viaStar = false) => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const module = moduleFor(file);
    if (name === '*') return [{ file, name: '*' }];
    const entry = module.exports.get(name);
    if (entry?.local) return [{ file, name: entry.local }];
    if (entry?.specifier) {
      return importTargets(file, entry.specifier, entry.imported)
        .flatMap((target) => (target.sink || target.name === '*' ? [target] : exportTargets(target.file, target.name, seen)));
    }
    const viaStars = module.stars.flatMap((specifier) => importTargets(file, specifier, name)
      .flatMap((target) => (target.sink ? [target] : exportTargets(target.file, target.name, seen, true))));
    if (viaStars.length || viaStar) return viaStars;
    // A name no declaration or star provides (a CommonJS module, a parse the
    // scan does not understand) is followed through the whole module, never dropped.
    return [{ file, name: '*' }];
  };

  // Graph successors of a set of references made in `module`.
  const successors = (module, references, outer = () => []) => {
    const next = references.sinks.map((sink) => ({ sink }));
    for (const name of references.names) {
      if (module.bindings.has(name)) next.push({ file: module.file, name });
      else if (module.imports.has(name)) {
        const { specifier, imported } = module.imports.get(name);
        next.push(...importTargets(module.file, specifier, imported)
          .flatMap((target) => (target.sink ? [target] : exportTargets(target.file, target.name))));
      } else if (!references.declared.has(name)) next.push(...outer(name));
      if (name === 'WebSocket' && !module.bindings.has(name) && !module.imports.has(name)) next.push({ sink: 'websocket' });
    }
    for (const { name, member } of references.memberRefs) {
      if (module.bindings.has(name)) next.push({ file: module.file, name, member });
      else if (module.imports.has(name)) {
        const { specifier, imported } = module.imports.get(name);
        next.push(...importTargets(module.file, specifier, imported)
          .flatMap((target) => (target.sink ? [target] : exportTargets(target.file, target.name)))
          .map((target) => (target.sink || target.name === '*' ? target : { ...target, member })));
      } else if (!references.declared.has(name)) next.push(...outer(name));
    }
    for (const { local, member } of references.namespaceMembers) {
      const { specifier } = module.imports.get(local);
      next.push(...importTargets(module.file, specifier, '*')
        .flatMap((target) => (target.sink ? [target] : exportTargets(target.file, member))));
    }
    for (const { specifier, members } of references.imports) {
      const targets = importTargets(module.file, specifier, '*');
      for (const target of targets) {
        if (target.sink) { next.push(target); continue; }
        next.push({ file: target.file, name: '*load*' });
        if (members) members.forEach((member) => next.push(...exportTargets(target.file, member)));
        else next.push(target);
      }
    }
    return next;
  };

  const nodeReferences = (module, node) => {
    if (!referenceCache.has(node)) referenceCache.set(node, collectReferences(node, module.namespaces));
    return referenceCache.get(node);
  };

  // Successors of a graph node `file#name`; `*` is the whole module, `*load*` its top-level statements.
  const expand = ({ file, name, member }) => {
    const module = moduleFor(file);
    if (member !== undefined) {
      const properties = memberNodes(module.bindings.get(name) ?? [], member);
      if (properties) return properties.flatMap((node) => successors(module, nodeReferences(module, node)));
      return expand({ file, name });
    }
    if (name === '*') {
      return [
        { file, name: '*load*' },
        ...[...module.bindings.keys()].map((binding) => ({ file, name: binding })),
        ...[...module.exports.keys()].flatMap((exported) => exportTargets(file, exported)),
        ...module.stars.flatMap((specifier) => importTargets(file, specifier, '*')),
      ];
    }
    const nodes = name === '*load*' ? module.sideEffects : (module.bindings.get(name) ?? []);
    return nodes.flatMap((node) => successors(module, nodeReferences(module, node)));
  };

  const nodeKey = ({ file, name, member }) => `${file}#${name}${member === undefined ? '' : `.${member}`}`;

  // Breadth-first, so the reported chain is a shortest path to a sink.
  const search = (start, { skipReviewed = true } = {}) => {
    const parent = new Map();
    const queue = [];
    const sinks = new Set();
    let first = null;
    const push = (target, from) => {
      if (target.sink) {
        sinks.add(target.sink);
        first ??= { from, sink: target.sink };
        return;
      }
      if (skipReviewed && reviewedKeys.has(`${target.file}#${target.name}`)) return;
      const key = nodeKey(target);
      if (parent.has(key)) return;
      parent.set(key, from);
      queue.push(target);
    };
    start.forEach((target) => push(target, null));
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      expand(current).forEach((target) => push(target, nodeKey(current)));
    }
    const chain = [];
    for (let key = first?.from; key; key = parent.get(key)) chain.unshift(keyLabel(key));
    return { sinks: [...sinks].sort(), chain: first ? [...chain, first.sink] : [] };
  };

  // Names a handler takes from enclosing functions: a parameter is an injected
  // dependency (opaque); a local is followed through its declaration.
  const enclosingResolver = (module, enclosing) => {
    const scopes = enclosing.map(functionScope);
    const resolveName = (name, depth = 0, seen = new Set()) => {
      if (seen.has(name)) return [];
      seen.add(name);
      for (const scope of scopes) {
        if (scope.params.has(name)) return [{ sink: 'injected-dependency' }];
        const locals = scope.locals.get(name);
        if (locals) {
          return locals.flatMap((node) => {
            const references = nodeReferences(module, node);
            return successors(module, references, (inner) => (depth > 20 ? [] : resolveName(inner, depth + 1, seen)));
          });
        }
      }
      return []; // a global (process, JSON, setTimeout, …)
    };
    return resolveName;
  };

  // Sink kinds each node reaches, memoized over strongly connected components
  // (iterative Tarjan), so the whole route table costs one walk of the graph.
  const sinksOf = new Map();
  const reachedSinks = (root) => {
    const rootKey = nodeKey(root);
    if (sinksOf.has(rootKey)) return sinksOf.get(rootKey);
    const index = new Map();
    const low = new Map();
    const local = new Map();
    const stack = [];
    const onStack = new Set();
    let counter = 0;
    const open = (target) => {
      const key = nodeKey(target);
      index.set(key, counter);
      low.set(key, counter);
      counter += 1;
      local.set(key, new Set());
      stack.push(key);
      onStack.add(key);
      return { key, successors: expand(target), next: 0 };
    };
    const frames = [open(root)];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.next < frame.successors.length) {
        const target = frame.successors[frame.next];
        frame.next += 1;
        if (target.sink) { local.get(frame.key).add(target.sink); continue; }
        if (reviewedKeys.has(`${target.file}#${target.name}`)) continue;
        const key = nodeKey(target);
        if (sinksOf.has(key)) sinksOf.get(key).forEach((sink) => local.get(frame.key).add(sink));
        else if (!index.has(key)) frames.push(open(target));
        else if (onStack.has(key)) low.set(frame.key, Math.min(low.get(frame.key), index.get(key)));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (low.get(frame.key) === index.get(frame.key)) {
        const members = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          members.push(member);
        } while (member !== frame.key);
        const kinds = new Set(members.flatMap((key) => [...local.get(key)]));
        members.forEach((key) => sinksOf.set(key, kinds));
      }
      if (parent) {
        low.set(parent.key, Math.min(low.get(parent.key), low.get(frame.key)));
        // A finished child outside the parent's component is final; one inside
        // it merges when the component closes.
        if (sinksOf.has(frame.key)) sinksOf.get(frame.key).forEach((sink) => local.get(parent.key).add(sink));
        else local.get(frame.key).forEach((sink) => local.get(parent.key).add(sink));
      }
    }
    return sinksOf.get(rootKey);
  };

  const handlerCalls = new Map();
  const routeStart = ({ source, routerId, method, path }) => {
    const module = moduleFor(join(repoRoot, source));
    if (!handlerCalls.has(module.file)) handlerCalls.set(module.file, routeCalls(module.ast));
    const calls = handlerCalls.get(module.file).filter((call) => call.routerId === routerId
      && [method.toLowerCase(), 'all'].includes(call.method) && call.path === path);
    if (calls.length === 0) throw new Error(`No ${method.toUpperCase()} '${path}' registration on ${routerId} in ${source}`);
    return calls.flatMap((call) => {
      const resolveOuter = enclosingResolver(module, call.enclosing);
      return call.handlers.flatMap((handler) => successors(module, collectReferences(handler, module.namespaces), resolveOuter));
    });
  };

  /** Sink kinds one route declaration (a scanRouteGraph `declarations` entry) can reach, sorted. */
  const routeSinks = (declaration) => {
    const kinds = new Set();
    for (const target of routeStart(declaration)) {
      if (target.sink) kinds.add(target.sink);
      else if (!reviewedKeys.has(`${target.file}#${target.name}`)) reachedSinks(target).forEach((sink) => kinds.add(sink));
    }
    return [...kinds].sort();
  };

  const explainRoute = (declaration) => search(routeStart(declaration));

  const traceSite = (siteLabel) => {
    const key = labelKey(siteLabel);
    const at = key.lastIndexOf('#');
    const file = key.slice(0, at);
    const name = key.slice(at + 1);
    if (!isFile(file) || !moduleFor(file).bindings.has(name)) return null;
    return search(expand({ file, name }), { skipReviewed: false });
  };

  return { routeSinks, explainRoute, traceSite };
}

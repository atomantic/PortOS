/** Non-executing ecosystem analysis. Unknown values remain opaque; they never
 * supply a process identity, object spread, or writable port source. */
import { parse } from '@babel/parser';

function walk(node, visit, parent = null, parentKey = null) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parent, parentKey);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'extra', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, node, key));
    else if (value && typeof value === 'object') walk(value, visit, node, key);
  }
}

const keyOf = node => node?.type === 'Identifier' ? node.name
  : ['StringLiteral', 'NumericLiteral'].includes(node?.type) ? String(node.value) : null;
const propertyKey = node => !node.computed || node.key?.type === 'StringLiteral' ? keyOf(node.key) : null;
const isExport = node => node?.type === 'MemberExpression' && node.object.type === 'Identifier' &&
  node.object.name === 'module' && (!node.computed || node.property.type === 'StringLiteral') && keyOf(node.property) === 'exports';
const isPort = value => Number.isInteger(value) && value > 0 && value <= 65535;

function contextFor(content) {
  const ast = parse(content, { sourceType: 'unambiguous' }).program;
  const bindings = new Map();
  let exported;
  let exportAssignment;
  for (const statement of ast.body) {
    if (exported && statement.type !== 'EmptyStatement') throw new Error('Statements after export');
    if (statement.type === 'VariableDeclaration') {
      for (const item of statement.declarations) {
        if (item.id.type === 'Identifier') {
          if (bindings.has(item.id.name) || ['module', 'exports'].includes(item.id.name)) throw new Error('Ambiguous binding');
          bindings.set(item.id.name, item.init);
        }
      }
    } else if (statement.type === 'FunctionDeclaration') bindings.set(statement.id.name, statement);
    else if (statement.type === 'ExportDefaultDeclaration') exported = statement.declaration;
    else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && isExport(statement.expression.left)) {
      if (exported) throw new Error('Multiple exports');
      exportAssignment = statement.expression;
      exported = exportAssignment.right;
    }
  }
  const protectedNodes = new Set();
  const resolve = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (node.type === 'Identifier') {
      const binding = bindings.get(node.name);
      if (binding?.start > node.start && binding.type !== 'FunctionDeclaration') return null;
      return resolve(binding, seen);
    }
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) {
      const key = !node.computed || node.property.type === 'StringLiteral' ? keyOf(node.property) : null;
      return key === null ? null : resolve(object(node.object, seen)?.get(key), seen);
    }
    return node;
  };
  const object = (input, seen = new Set()) => {
    const node = resolve(input, new Set(seen));
    if (!node) return null;
    if (node.type === 'ConditionalExpression') {
      const left = object(node.consequent, new Set([...seen, node]));
      const right = object(node.alternate, new Set([...seen, node]));
      if (!left || !right) return null;
      return new Map([...new Set([...left.keys(), ...right.keys()])].map(key => [key,
        left.get(key) === right.get(key) ? left.get(key) : null]));
    }
    if (node.type === 'CallExpression') {
      // Only a local helper's literal return shape is usable for spreads.
      // Imported helpers remain opaque, even when their name looks familiar.
      const fn = resolve(node.callee);
      const returns = fn?.body?.type === 'BlockStatement'
        ? fn.body.body.filter(statement => statement.type === 'ReturnStatement') : [];
      if (returns.length !== 1 || fn.body.body.some(statement => !['VariableDeclaration', 'ReturnStatement'].includes(statement.type)) || !['FunctionDeclaration', 'ArrowFunctionExpression', 'FunctionExpression'].includes(fn?.type)) return null;
      // Do not resolve function locals/parameters against module bindings. Only
      // the fixed key footprint is known; all returned values remain opaque.
      const returned = returns[0].argument;
      if (returned?.type !== 'ObjectExpression' || returned.properties.some(property =>
        property.type !== 'ObjectProperty' || propertyKey(property) === null || propertyKey(property) === '__proto__')) return null;
      return new Map(returned.properties.map(property => [propertyKey(property), null]));
    }
    if (node.type !== 'ObjectExpression') return null;
    protectedNodes.add(node);
    const fields = new Map();
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        const spread = object(property.argument, new Set([...seen, node]));
        if (!spread) return null;
        for (const [key, value] of spread) fields.set(key, value);
      } else {
        const key = propertyKey(property);
        if (key === null || property.type !== 'ObjectProperty' || key === '__proto__') return null;
        fields.set(key, property.value);
      }
    }
    return fields;
  };
  const portReads = new Set();
  const structuralObject = (input, seen = new Set()) => {
    if (!input || seen.has(input)) return null;
    seen.add(input);
    portReads.add(input);
    const resolved = resolve(input);
    if (resolved?.type === 'ObjectExpression') {
      for (const property of resolved.properties) {
        if (property.type === 'SpreadElement') structuralObject(property.argument, seen);
      }
    }
    return object(input);
  };
  const scalar = node => {
    const resolved = resolve(node);
    if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(resolved?.type)) return resolved.value;
    if (resolved?.type === 'NullLiteral') return null;
    if (resolved?.type === 'TemplateLiteral' && resolved.expressions.length === 0) return resolved.quasis[0].value.cooked;
    return undefined;
  };
  return { ast, bindings, exported, exportAssignment, protectedNodes, resolve, object, scalar, portReads, structuralObject };
}

function portSource(node, context, track = true) {
  if (track && node) context.portReads.add(node);
  const resolved = context.resolve(node);
  if (!resolved) return null;
  if (resolved.type === 'LogicalExpression' && ['||', '??'].includes(resolved.operator)) {
    const left = context.scalar(resolved.left);
    if (left !== undefined) {
      const usesLeft = resolved.operator === '||' ? Boolean(left) : left !== null;
      return portSource(usesLeft ? resolved.left : resolved.right, context, track);
    }
    // Environment overrides have a meaningful configurable default. Arbitrary
    // calls/arithmetic do not establish which operand supplies the listener.
    const candidate = context.resolve(resolved.left) || resolved.left;
    const env = candidate?.type === 'MemberExpression' && candidate.object;
    if (env?.type !== 'MemberExpression' || env.object?.name !== 'process' || keyOf(env.property) !== 'env') return null;
    return portSource(resolved.right, context, track);
  }
  const value = context.scalar(resolved);
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return isPort(port) ? { value: port, start: resolved.start, end: resolved.end,
    quoted: resolved.type === 'StringLiteral' } : null;
}

function argsSource(node, context, content) {
  const resolved = context.resolve(node);
  const value = context.scalar(node);
  if (typeof value === 'string' && resolved.type === 'StringLiteral') {
    // Escaped strings cannot be mapped from cooked text back to source offsets.
    const raw = content.slice(resolved.start + 1, resolved.end - 1);
    if (raw !== value) return null;
    if ([...raw.matchAll(/(?:^|\s)--port(?:\s+|=)/g)].length !== 1) return null;
    const match = /(?:^|\s)--port(?:\s+|=)(\d+)(?=\s|$)/.exec(raw);
    if (match) {
      const start = resolved.start + 1 + match.index + match[0].length - match[1].length;
      return { value: Number(match[1]), start, end: start + match[1].length };
    }
  }
  if (resolved?.type === 'TemplateLiteral') {
    if (resolved.expressions.some(expression => context.scalar(expression) === undefined)) return null;
    const rendered = resolved.quasis.map((quasi, index) => quasi.value.cooked +
      (index < resolved.expressions.length ? context.scalar(resolved.expressions[index]) : '')).join('');
    if ([...rendered.matchAll(/(?:^|\s)--port(?:\s+|=)/g)].length !== 1) return null;
    for (let index = 0; index < resolved.expressions.length; index++) {
      if (/--port(?:\s+|=)$/.test(resolved.quasis[index].value.cooked) &&
          (/^(?:\s)/.test(resolved.quasis[index + 1].value.cooked) ||
            (index === resolved.expressions.length - 1 && resolved.quasis[index + 1].value.cooked === ''))) return portSource(resolved.expressions[index], context);
    }
  }
  return null;
}

function processInfo(node, context, content) {
  const fields = context.structuralObject(node);
  if (!fields) throw new Error('Unknown process shape');
  const name = context.scalar(fields.get('name'));
  if (typeof name !== 'string' || !name) throw new Error('Unknown process name');
  const sources = new Map();
  const ports = {};
  const add = (label, source, primary = true) => {
    if (!source) return;
    if (!sources.has(label)) sources.set(label, []);
    sources.get(label).push(source);
    if (primary) ports[label] = source.value;
  };
  const explicit = fields.has('ports') ? context.structuralObject(fields.get('ports')) : null;
  if (fields.has('ports') && !explicit) throw new Error('Unknown ports map');
  for (const [label, value] of explicit || []) add(label, portSource(value, context));
  const env = new Map();
  const envKeys = [...fields.keys()].filter(key => /^env(?:_.+)?$/.test(key));
  const precedence = key => key === 'env' ? 0 : key === 'env_development' ? 1 : key === 'env_production' ? 3 : 2;
  envKeys.sort((a, b) => precedence(a) - precedence(b));
  for (const key of envKeys) {
    if (!fields.has(key)) continue;
    const block = context.structuralObject(fields.get(key));
    if (!block) throw new Error('Unknown environment shape');
    for (const [key, value] of block) {
      if (/^(?:PORT|[A-Z][A-Z0-9_]*_PORT)$/.test(key)) {
        if (!env.has(key)) env.set(key, []);
        env.get(key).push(portSource(value, context));
      }
    }
  }
  const runtimeUiLabel = explicit?.has('devUi') ? 'devUi' : 'ui';
  const envLabel = key => key === 'PORT'
    ? /[-_](ui|client)$/i.test(name) ? runtimeUiLabel : /[-_]browser$/i.test(name) && env.has('CDP_PORT') ? 'health' : 'api'
    : key === 'VITE_PORT' ? runtimeUiLabel : key === 'CDP_PORT' ? 'cdp'
      : key.replace(/_PORT$/, '').toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase());
  for (const [key, values] of env) {
    const label = envLabel(key);
    for (const source of values) add(label, source, !explicit?.size);
    if (values.some(source => source === null)) sources.set(label, [null]);
    if (!explicit?.size && values.at(-1) === null) delete ports[label];
  }
  const args = argsSource(fields.get('args'), context, content);
  add(runtimeUiLabel, args, !explicit?.size && Object.keys(ports).length === 0);
  const argsValue = context.scalar(fields.get('args'));
  if (fields.has('args') && !args && (typeof argsValue !== 'string' || /--port(?:\s|=)/.test(argsValue))) {
    if (!sources.has(runtimeUiLabel)) sources.set(runtimeUiLabel, []);
    sources.get(runtimeUiLabel).push(null);
  }
  if (!explicit?.size && Object.keys(ports).length === 0) add('api', portSource(fields.get('port'), context));
  const usesVite = /\bvite\b/i.test(context.scalar(fields.get('script')) || '') ||
    /\bvite\b/i.test(context.scalar(fields.get('args')) || '') || env.has('VITE_PORT');
  return { name, ports, sources, cwd: context.scalar(fields.get('cwd')) ?? null, usesVite };
}

function assertNoSideEffects(context) {
  const { ast, bindings, exportAssignment, protectedNodes, resolve } = context;
  const touchesConfig = node => {
    const seen = new Set();
    let touches = false;
    const inspect = input => walk(input, part => {
      if (seen.has(part)) return;
      seen.add(part);
      const resolved = resolve(part);
      if (isExport(part) || (part.type === 'Identifier' && ['module', 'exports'].includes(part.name)) || protectedNodes.has(resolved)) touches = true;
      // An escaping wrapper/callback can carry an alias of the configuration.
      if (resolved && resolved !== part && !seen.has(resolved)) inspect(resolved);
    });
    inspect(node);
    return touches;
  };
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' &&
        (node.id.type !== 'Identifier' || bindings.get(node.id.name) !== node.init) && touchesConfig(node.init)) {
      throw new Error('Unsupported configuration alias');
    }
    if ((node.type === 'AssignmentExpression' && node !== exportAssignment) ||
        ['UpdateExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type) ||
        (node.type === 'UnaryExpression' && node.operator === 'delete')) throw new Error('Dynamic mutation');
    if (node.type === 'WithStatement' || (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name))) throw new Error('Dynamic evaluation');
    if (['CallExpression', 'NewExpression', 'OptionalCallExpression', 'TaggedTemplateExpression'].includes(node.type)) {
      const inputs = node.arguments || [node.quasi];
      if (inputs.some(touchesConfig) || (['MemberExpression', 'OptionalMemberExpression'].includes(node.callee?.type) && touchesConfig(node.callee.object))) {
        throw new Error('Configuration escapes to a call');
      }
    }
  });
}

function markNonPortConsumers(context, processes) {
  const forbidden = new Set();
  const mark = (input, seen = new Set()) => {
    if (!input || seen.has(input)) return;
    seen.add(input);
    const source = portSource(input, context, false);
    if (source) { forbidden.add(`${source.start}:${source.end}`); return; }
    const resolved = context.resolve(input);
    if (resolved?.type === 'ObjectExpression') {
      for (const property of resolved.properties) mark(property.value || property.argument, seen);
    } else if (resolved?.type === 'ArrayExpression') resolved.elements.forEach(element => mark(element, seen));
    else if (['MemberExpression', 'OptionalMemberExpression'].includes(input.type)) mark(input.object, seen);
  };
  walk(context.ast, (node, parent, key) => {
    if (!['Identifier', 'MemberExpression', 'OptionalMemberExpression'].includes(node.type) || context.portReads.has(node)) return;
    if ((key === 'key' && !parent.computed) || (key === 'property' && !parent.computed) ||
        (key === 'object' && ['MemberExpression', 'OptionalMemberExpression'].includes(parent?.type)) ||
        key === 'id' || key === 'params' || (parent?.type === 'VariableDeclarator' && key === 'init')) return;
    mark(node);
  });
  for (const proc of processes) {
    for (const sources of proc.sources.values()) {
      for (const source of sources) {
        if (source && forbidden.has(`${source.start}:${source.end}`)) source.nonPortConsumer = true;
      }
    }
  }
}

/** Returns null for ambiguous configuration; never executes helpers or imports. */
export function analyzeEcosystemPorts(content) {
  try {
    const context = contextFor(content);
    context.portReads.add(context.exported);
    const exported = context.resolve(context.exported);
    const config = context.structuralObject(exported);
    const appsInput = exported?.type === 'ArrayExpression' ? exported : config?.get('apps');
    context.portReads.add(appsInput);
    // The shipped exported PORTS map intentionally exposes these same defaults.
    if (config?.has('PORTS')) context.portReads.add(config.get('PORTS'));
    const apps = context.resolve(appsInput);
    if (apps?.type !== 'ArrayExpression') return null;
    context.protectedNodes.add(apps);
    const processes = apps.elements.map(node => processInfo(node, context, content));
    if (new Set(processes.map(proc => proc.name)).size !== processes.length) return null;
    assertNoSideEffects(context);
    markNonPortConsumers(context, processes);
    if (processes.some(proc => proc.ports.api)) {
      for (const proc of processes) {
        if (proc.usesVite && proc.ports.ui && !proc.ports.devUi) {
          proc.ports.devUi = proc.ports.ui;
          delete proc.ports.ui;
          proc.sources.set('devUi', proc.sources.get('ui'));
          proc.sources.delete('ui');
        }
      }
    }
    return processes;
  } catch {
    return null;
  }
}

/** All edits are planned against the original source. A failed attribution or
 * overlapping/shared source leaves the entire input byte-identical. */
export function planEcosystemPortEdits(content, remap = [], edits = []) {
  const pairs = [...(remap || [])].filter(([oldPort, newPort]) => oldPort !== newPort);
  const requested = (edits || []).filter(edit => edit.oldPort !== edit.newPort);
  const failed = () => ({ content, applied: [], unapplied: requested, remapApplied: false });
  if (!pairs.length && !requested.length) return { ...failed(), unapplied: [] };
  const processes = analyzeEcosystemPorts(content);
  if (!processes) return failed();
  const expanded = [...requested];
  for (const [oldPort, newPort] of pairs) {
    const matches = processes.flatMap(proc => Object.entries(proc.ports).filter(([, value]) => value === oldPort)
      .map(([label]) => ({ processName: proc.name, label, oldPort, newPort })));
    // Legacy value remaps have no process identity. Multiple owners are ambiguous.
    if (matches.length !== 1) return failed();
    expanded.push(...matches);
  }
  const replacements = new Map();
  for (const edit of expanded) {
    const proc = processes.find(proc => proc.name === edit.processName);
    const label = edit.label === 'ui' && proc?.ports.ui === undefined && proc?.usesVite ? 'devUi' : edit.label;
    if (!proc || proc.ports[label] !== edit.oldPort || !isPort(edit.newPort)) return failed();
    const sources = proc.sources.get(label) || [];
    if (!sources.length || sources.some(source => source === null)) return failed();
    for (const source of sources) {
      if (source.nonPortConsumer || source.value !== edit.oldPort) return failed();
      const key = `${source.start}:${source.end}`;
      const replacement = source.quoted ? JSON.stringify(String(edit.newPort)) : String(edit.newPort);
      if (replacements.has(key) && replacements.get(key).text !== replacement) return failed();
      // A shared constant cannot be changed on behalf of an unselected owner.
      for (const other of processes) {
        for (const [otherLabel, otherSources] of other.sources) {
          if (!otherSources.some(item => item?.start === source.start && item?.end === source.end)) continue;
          if (!expanded.some(item => item.processName === other.name &&
              (item.label === otherLabel || item.label === 'ui' && otherLabel === 'devUi' && other.usesVite) && item.newPort === edit.newPort)) return failed();
        }
      }
      replacements.set(key, { ...source, text: replacement });
    }
  }
  let updated = content;
  let boundary = content.length;
  for (const span of [...replacements.values()].sort((a, b) => b.start - a.start)) {
    if (span.end > boundary) return failed();
    updated = updated.slice(0, span.start) + span.text + updated.slice(span.end);
    boundary = span.start;
  }
  return { content: updated, applied: requested, unapplied: [], remapApplied: pairs.length > 0 };
}

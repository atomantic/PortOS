/** Non-executing ecosystem analysis. Unknown values remain opaque; they never
 * supply a process identity, object spread, or writable port source. */
import { parse } from '@babel/parser';

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'extra', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
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
    if (node.type === 'MemberExpression') {
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
  const scalar = node => {
    const resolved = resolve(node);
    if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(resolved?.type)) return resolved.value;
    if (resolved?.type === 'TemplateLiteral' && resolved.expressions.length === 0) return resolved.quasis[0].value.cooked;
    return undefined;
  };
  return { ast, bindings, exported, exportAssignment, protectedNodes, resolve, object, scalar };
}

function portSource(node, context) {
  const resolved = context.resolve(node);
  if (!resolved) return null;
  if (resolved.type === 'LogicalExpression' && ['||', '??'].includes(resolved.operator)) return portSource(resolved.right, context);
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
          /^(?:\s|$)/.test(resolved.quasis[index + 1].value.cooked)) return portSource(resolved.expressions[index], context);
    }
  }
  return null;
}

function processInfo(node, context, content) {
  const fields = context.object(node);
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
  const explicit = fields.has('ports') ? context.object(fields.get('ports')) : null;
  if (fields.has('ports') && !explicit) throw new Error('Unknown ports map');
  for (const [label, value] of explicit || []) add(label, portSource(value, context));
  const env = new Map();
  for (const key of ['env', 'env_development', 'env_production']) {
    if (!fields.has(key)) continue;
    const block = context.object(fields.get(key));
    if (!block) throw new Error('Unknown environment shape');
    for (const [key, value] of block) {
      if (/^(?:PORT|[A-Z][A-Z0-9_]*_PORT)$/.test(key)) {
        if (!env.has(key)) env.set(key, []);
        env.get(key).push(portSource(value, context));
      }
    }
  }
  const envLabel = key => key === 'PORT'
    ? /[-_](ui|client)$/i.test(name) ? 'ui' : /[-_]browser$/i.test(name) && env.has('CDP_PORT') ? 'health' : 'api'
    : key === 'VITE_PORT' ? 'ui' : key === 'CDP_PORT' ? 'cdp'
      : key.replace(/_PORT$/, '').toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase());
  for (const [key, values] of env) {
    const label = envLabel(key);
    for (const source of values) add(label, source, !explicit?.size);
    if (values.some(source => source === null)) sources.set(label, [null]);
    if (!explicit?.size && values.at(-1) === null) delete ports[label];
  }
  const args = argsSource(fields.get('args'), context, content);
  add('ui', args, !explicit?.size && Object.keys(ports).length === 0);
  const argsValue = context.scalar(fields.get('args'));
  if (fields.has('args') && !args && (typeof argsValue !== 'string' || /--port(?:\s|=)/.test(argsValue))) {
    if (!sources.has('ui')) sources.set('ui', []);
    sources.get('ui').push(null);
  }
  if (!explicit?.size && Object.keys(ports).length === 0) add('api', portSource(fields.get('port'), context));
  const usesVite = /\bvite\b/i.test(context.scalar(fields.get('script')) || '') ||
    /\bvite\b/i.test(context.scalar(fields.get('args')) || '') || env.has('VITE_PORT');
  return { name, ports, sources, cwd: context.scalar(fields.get('cwd')) ?? null, usesVite };
}

function assertNoSideEffects(context) {
  const { ast, exportAssignment, protectedNodes, resolve } = context;
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
    if ((node.type === 'AssignmentExpression' && node !== exportAssignment) ||
        ['UpdateExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type) ||
        (node.type === 'UnaryExpression' && node.operator === 'delete')) throw new Error('Dynamic mutation');
    if (node.type === 'WithStatement' || (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name))) throw new Error('Dynamic evaluation');
    if (['CallExpression', 'NewExpression', 'OptionalCallExpression', 'TaggedTemplateExpression'].includes(node.type)) {
      const inputs = node.arguments || [node.quasi];
      if (inputs.some(touchesConfig) || (node.callee?.type === 'MemberExpression' && touchesConfig(node.callee.object))) {
        throw new Error('Configuration escapes to a call');
      }
    }
  });
}

/** Returns null for ambiguous configuration; never executes helpers or imports. */
export function analyzeEcosystemPorts(content) {
  try {
    const context = contextFor(content);
    const exported = context.resolve(context.exported);
    const apps = exported?.type === 'ArrayExpression' ? exported : context.resolve(context.object(exported)?.get('apps'));
    if (apps?.type !== 'ArrayExpression') return null;
    context.protectedNodes.add(apps);
    const processes = apps.elements.map(node => processInfo(node, context, content));
    if (new Set(processes.map(proc => proc.name)).size !== processes.length) return null;
    assertNoSideEffects(context);
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
      if (source.value !== edit.oldPort) return failed();
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

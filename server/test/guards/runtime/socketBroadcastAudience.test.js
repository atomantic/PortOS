import { parse } from '@babel/parser';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const SERVER_HANDLES = new Set(['io', 'ioInstance', 'boundIo', 'providersIo', 'ioRef', 'ns']);
const MAY_HAVE_SERVER_HANDLE = new RegExp(`\\b(?:${[...SERVER_HANDLES, 'getIo'].join('|')})\\b`);
const SCOPED_METHODS = new Set(['in', 'to']);
const isMember = (node) => ['MemberExpression', 'OptionalMemberExpression'].includes(node?.type);
const isCall = (node) => ['CallExpression', 'OptionalCallExpression'].includes(node?.type);
const memberName = (node) => node.computed ? node.property.value : node.property.name;

function hasUnscopedServerReceiver(node) {
  if (node.type === 'Identifier') return SERVER_HANDLES.has(node.name);
  if (isMember(node)) return SERVER_HANDLES.has(memberName(node)) || hasUnscopedServerReceiver(node.object);
  if (!isCall(node)) return false;
  const { callee, arguments: args } = node;
  if (callee.type === 'Identifier') return callee.name === 'getIo';
  if (!isMember(callee)) return false;

  const method = memberName(callee);
  if (SCOPED_METHODS.has(method)) return false;
  if (method === 'of' && args[0]?.type === 'StringLiteral' && args[0].value.startsWith('/') && args[0].value !== '/') return false;
  if (method === 'get') return args[0]?.type === 'StringLiteral' && args[0].value === 'io';
  return hasUnscopedServerReceiver(callee.object);
}

function findUnscopedEmits(source) {
  if (!source.includes('\\u') && (!source.includes('emit') || !MAY_HAVE_SERVER_HANDLE.test(source))) return [];
  const violations = [];
  function visit(node) {
    if (isCall(node) && isMember(node.callee) && memberName(node.callee) === 'emit'
      && hasUnscopedServerReceiver(node.callee.object)) violations.push(node.loc.start.line);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child);
      } else if (value?.type) visit(value);
    }
  }
  visit(parse(source, { sourceType: 'unambiguous', attachComment: false }).program);
  return violations;
}

describe('Socket.IO operator broadcast audience', () => {
  it('requires operator broadcasts to go through the shared audience helper', () => {
    const violations = trackedFiles(SERVER_ROOT, ['*.js']).flatMap((file) => {
      if (file.endsWith('.test.js') || file.startsWith('test/') || file.startsWith('cos-runner/')
        || file === 'lib/socketAudience.js') return [];
      return findUnscopedEmits(readText(join(SERVER_ROOT, file))).map(line => `${file}:${line}`);
    });
    expect(violations, 'Use emitToOperators or emitToOperatorsOn for operator broadcasts.').toEqual([]);
  });

  it('finds optional, computed, exclusion-only and route-given server emits', () => {
    expect(findUnscopedEmits([
      "io.emit('example');",
      "getIo()?.emit('example');",
      "req.app.get('io')?.['emit']('example');",
      "getIo().except(otherRoom).emit('example');",
      "job.io?.local.emit('example');",
      "io.of('/').volatile.emit('example');",
    ].join('\n'))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('allows individual sends, explicit room and namespace sends, and the operator helpers', () => {
    expect(findUnscopedEmits(`
      socket.emit('build:id', build);
      io.to(activeRoom).emit('example:scoped');
      io.of('/hosted').emit('example:hosted');
      emitToOperatorsOn(io, 'example');
      emitToOperatorsOn(getIo()?.except(otherRoom), 'example');
      // io.emit('comment');
      const example = "io.emit('template')";
    `)).toEqual([]);
  });
});

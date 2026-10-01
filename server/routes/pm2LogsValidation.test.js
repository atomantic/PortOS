import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';

const routeFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const filepath = join(directory, entry.name);
  if (entry.isDirectory()) return routeFiles(filepath);
  return entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [filepath] : [];
});

const nodesWithin = (node) => {
  const nodes = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value.type === 'string') nodes.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'loc' && key !== 'comments' && key !== 'tokens') visit(child);
    }
  };
  visit(node);
  return nodes;
};

const unvalidatedPm2LogReads = (source) => {
  const ast = parse(source, { sourceType: 'unambiguous' });
  return nodesWithin(ast).flatMap((node) => {
    if (node.type !== 'CallExpression'
      || node.callee?.type !== 'MemberExpression'
      || node.callee.property?.name !== 'get'
      || node.callee.object?.type !== 'Identifier'
      || node.arguments.length < 2) return [];

    const handlerNodes = nodesWithin(node.arguments[node.arguments.length - 1]);
    const pm2LogReads = handlerNodes.filter((child) => child.type === 'CallExpression'
      && child.callee?.type === 'MemberExpression'
      && child.callee.object?.name === 'pm2Service'
      && child.callee.property?.name === 'getLogs');
    if (pm2LogReads.length === 0) return [];

    const validatesLinesBeforeRead = handlerNodes.some((child) => child.type === 'CallExpression'
      && child.callee?.type === 'Identifier'
      && child.callee.name === 'validateRequest'
      && (child.arguments[0]?.name === 'logsQuerySchema'
        || (child.arguments[0]?.type === 'CallExpression'
          && child.arguments[0].callee?.property?.name === 'pick'
          && child.arguments[0].callee?.object?.name === 'logsQuerySchema'))
      && child.start < Math.min(...pm2LogReads.map(({ start }) => start)));
    return validatesLinesBeforeRead ? [] : [{ start: node.start }];
  });
};

describe('PM2 log route validation', () => {
  it('validates the bounded lines query in every route handler that reads PM2 logs', () => {
    const routesDirectory = new URL('.', import.meta.url);
    const files = routeFiles(routesDirectory.pathname);
    const callSites = files.flatMap((filepath) => {
      const source = readFileSync(filepath, 'utf8');
      return unvalidatedPm2LogReads(source).map(({ start }) => ({
        file: filepath.slice(routesDirectory.pathname.length), start,
      }));
    });

    expect(callSites).toEqual([]);
  });

  it('does not inherit validation from a neighboring route or code after the PM2 call', () => {
    const precedingValidatedRoute = `
      router.get('/validated', asyncHandler(async (req, res) => {
        const { lines } = validateRequest(logsQuerySchema, req.query);
        res.json({ lines });
      }));
      router.get('/unvalidated', asyncHandler(async (req, res) => {
        const logs = await pm2Service.getLogs('worker', req.query.lines);
        res.json({ logs });
      }));
    `;
    const validationAfterRead = `
      router.get('/unvalidated', asyncHandler(async (req, res) => {
        const logs = await pm2Service.getLogs('worker', req.query.lines);
        const { lines } = validateRequest(logsQuerySchema, req.query);
        res.json({ logs, lines });
      }));
    `;

    expect(unvalidatedPm2LogReads(precedingValidatedRoute)).toHaveLength(1);
    expect(unvalidatedPm2LogReads(validationAfterRead)).toHaveLength(1);
  });
});

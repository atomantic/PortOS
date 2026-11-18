#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { runAgentContextEval } from '../server/services/agent/agentContextEval.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultFixture = resolve(repoRoot, 'server/test/fixtures/agent-context-eval.json');

const parseArgs = (args) => {
  let fixture = defaultFixture;
  let failureThreshold = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--fixture') {
      if (!args[index + 1]) throw new Error('--fixture requires a path');
      fixture = resolve(args[index + 1]);
      index += 1;
    } else if (argument === '--failure-threshold') {
      if (!args[index + 1]) throw new Error('--failure-threshold requires a value');
      failureThreshold = Number(args[index + 1]);
      index += 1;
    } else if (argument.startsWith('--failure-threshold=')) {
      failureThreshold = Number(argument.slice('--failure-threshold='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!Number.isInteger(failureThreshold) || failureThreshold < 0) {
    throw new Error('--failure-threshold must be a non-negative integer');
  }
  return { fixture, failureThreshold };
};

const main = async () => {
  const { fixture, failureThreshold } = parseArgs(process.argv.slice(2));
  const suite = JSON.parse(await readFile(fixture, 'utf8'));
  return runAgentContextEval(suite, { failureThreshold });
};

main().then((report) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}).catch((error) => {
  process.stdout.write(`${JSON.stringify({
    kind: 'portos-agent-context-eval',
    reportVersion: 1,
    passed: false,
    error: error.message,
  }, null, 2)}\n`);
  process.exitCode = 1;
});

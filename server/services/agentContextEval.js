import { z } from 'zod';
import { createAgentContextContract } from './agentContextMcp.js';

export const AGENT_CONTEXT_EVAL_REPORT_VERSION = 1;

const fixtureSchema = z.object({
  navigation: z.array(z.record(z.string(), z.unknown())).optional(),
  workspaces: z.array(z.record(z.string(), z.unknown())).optional(),
  brain: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  identity: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  sourceStatus: z.record(z.string(), z.enum(['fresh', 'stale'])).optional(),
  errors: z.array(z.enum(['navigation', 'workspaces', 'brain', 'identity'])).optional(),
}).strict();

const pathExpectationSchema = z.object({
  path: z.string().min(1),
  value: z.unknown(),
}).strict();

const limitExpectationSchema = z.object({
  path: z.string().min(1),
  value: z.number().int().min(0),
}).strict();

const expectationSchema = z.object({
  isError: z.boolean().optional(),
  inputSchemaValid: z.boolean().optional(),
  outputSchemaValid: z.boolean().optional(),
  contentParity: z.boolean().optional(),
  advertisedToolsCovered: z.boolean().optional(),
  readOnlyTools: z.boolean().optional(),
  withinBudgets: z.boolean().optional(),
  equals: z.array(pathExpectationSchema).optional(),
  contains: z.array(pathExpectationSchema).optional(),
  excludes: z.array(z.string()).optional(),
  absentKeys: z.array(z.string()).optional(),
  maxItems: z.array(limitExpectationSchema).optional(),
  maxChars: z.array(limitExpectationSchema).optional(),
}).strict();

const caseSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(240),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  source: z.string().min(1).max(500),
  fixture: z.string().min(1).max(120),
  operation: z.enum(['manifest', 'tool']),
  tool: z.string().min(1).max(120).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()),
  skip: z.string().min(1).max(500).optional(),
  expect: expectationSchema.optional(),
}).strict().refine((value) => value.operation !== 'tool' || value.tool, {
  message: 'Tool cases require a tool name',
  path: ['tool'],
});

export const agentContextEvalSuiteSchema = z.object({
  name: z.string().min(1).max(120),
  version: z.number().int().positive(),
  fixtures: z.record(z.string(), fixtureSchema),
  cases: z.array(caseSchema).min(1),
}).strict();

const resolvePath = (value, path) => path.split('.').reduce((current, part) => {
  if (current === null || current === undefined) return undefined;
  return part === 'length' ? current.length : current[part];
}, value);

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const collectKeys = (value, keys = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => {
      keys.add(key);
      collectKeys(entry, keys);
    });
  }
  return keys;
};

const valueTypeMatches = (value, type) => {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
};

const validateJsonSchema = (value, schema, path = '$') => {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.anyOf)) {
    const candidates = schema.anyOf.map((candidate) => validateJsonSchema(value, candidate, path));
    return candidates.some((errors) => errors.length === 0)
      ? []
      : [`${path} does not match any advertised schema variant`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameValue(entry, value))) {
    return [`${path} is not an advertised enum value`];
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => valueTypeMatches(value, type))) {
    return [`${path} has type ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}; expected ${types.join('|')}`];
  }
  if (value === null || value === undefined) return [];

  const errors = [];
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    value.forEach((entry, index) => errors.push(...validateJsonSchema(entry, schema.items, `${path}.${index}`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required} is required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        errors.push(...validateJsonSchema(entry, schema.properties[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not advertised`);
      }
    }
  }
  return errors;
};

const fixtureResolver = (commands) => (query) => {
  const needle = String(query ?? '').toLowerCase();
  const command = commands.find((entry) => [entry.id, entry.label, entry.path, ...(entry.aliases ?? []), ...(entry.keywords ?? [])]
    .some((candidate) => String(candidate ?? '').toLowerCase() === needle));
  return command ? { command } : null;
};

const createFixtureContract = (fixture, settings) => {
  const isolated = structuredClone(fixture);
  const errors = new Set(isolated.errors ?? []);
  const rejectIfConfigured = (scope) => {
    if (errors.has(scope)) throw new Error(`Fixture source unavailable: ${scope}`);
  };
  const navigation = isolated.navigation ?? [];
  return createAgentContextContract({
    readSettings: async () => structuredClone(settings),
    navigationCommands: navigation,
    resolveNavigation: fixtureResolver(navigation),
    listWorkspaceContexts: async () => {
      rejectIfConfigured('workspaces');
      return structuredClone(isolated.workspaces ?? []);
    },
    brainSearchTypes: Object.keys(isolated.brain ?? {}),
    getBrainRecords: async (type) => {
      rejectIfConfigured('brain');
      return structuredClone(isolated.brain?.[type] ?? []);
    },
    previewIdentityExport: async () => {
      rejectIfConfigured('identity');
      return { sections: structuredClone(isolated.identity ?? {}) };
    },
    getSourceStatus: async (scope) => {
      rejectIfConfigured(scope);
      return isolated.sourceStatus?.[scope] ?? 'fresh';
    },
    readRecipeCatalog: async () => [],
  });
};

const evaluateExpectations = ({ evalCase, manifest, toolResult, suite }) => {
  const expect = evalCase.expect ?? {};
  const output = toolResult?.structuredContent;
  const payload = { manifest, output, toolResult };
  const findings = [];
  const advertisedTool = manifest.tools.find((tool) => tool.name === evalCase.tool);

  if (expect.isError !== undefined && Boolean(toolResult?.isError) !== expect.isError) {
    findings.push(`Expected isError=${expect.isError}, received ${Boolean(toolResult?.isError)}`);
  }
  if (expect.inputSchemaValid !== undefined) {
    const valid = advertisedTool ? validateJsonSchema(evalCase.args ?? {}, advertisedTool.inputSchema).length === 0 : false;
    if (valid !== expect.inputSchemaValid) findings.push(`Advertised input schema validity was ${valid}`);
  }
  if (expect.outputSchemaValid) {
    if (!advertisedTool) findings.push(`Tool ${evalCase.tool} is not advertised`);
    else findings.push(...validateJsonSchema(output, advertisedTool.outputSchema).map((message) => `Output schema: ${message}`));
  }
  if (expect.contentParity) {
    const text = toolResult?.content?.[0]?.text;
    const parsed = typeof text === 'string' ? JSON.parse(text) : undefined;
    if (!sameValue(parsed, output)) findings.push('Text and structured tool outputs differ');
  }
  if (expect.advertisedToolsCovered) {
    const advertised = manifest.tools.map((tool) => tool.name).sort();
    const covered = [...new Set(suite.cases.filter((candidate) => candidate.operation === 'tool' && !candidate.skip)
      .map((candidate) => candidate.tool))].sort();
    if (!sameValue(advertised, covered)) findings.push(`Advertised/runtime case parity differs: advertised=${advertised.join(',')} covered=${covered.join(',')}`);
  }
  if (expect.readOnlyTools) {
    const unsafe = manifest.tools.filter((tool) => tool.annotations?.readOnlyHint !== true
      || tool.annotations?.destructiveHint !== false
      || tool.annotations?.idempotentHint !== true
      || tool.annotations?.openWorldHint !== false);
    if (unsafe.length > 0) findings.push(`Tools lack read-only annotations: ${unsafe.map((tool) => tool.name).join(', ')}`);
  }
  if (expect.withinBudgets && output !== undefined) {
    const chars = JSON.stringify(output).length;
    const approxTokens = Math.ceil(chars / 4);
    if (chars > manifest.limits.maxResponseChars) findings.push(`Output uses ${chars} chars; limit is ${manifest.limits.maxResponseChars}`);
    if (approxTokens > manifest.limits.maxApproxTokens) findings.push(`Output uses ~${approxTokens} tokens; limit is ${manifest.limits.maxApproxTokens}`);
  }
  for (const check of expect.equals ?? []) {
    const actual = resolvePath(payload, check.path);
    if (!sameValue(actual, check.value)) findings.push(`${check.path} expected ${JSON.stringify(check.value)}; received ${JSON.stringify(actual)}`);
  }
  for (const check of expect.contains ?? []) {
    const actual = resolvePath(payload, check.path);
    if (typeof actual === 'string' ? !actual.includes(check.value) : !Array.isArray(actual) || !actual.includes(check.value)) {
      findings.push(`${check.path} does not contain ${JSON.stringify(check.value)}`);
    }
  }
  const serialized = JSON.stringify(payload);
  for (const forbidden of expect.excludes ?? []) {
    if (serialized.includes(forbidden)) findings.push(`Output contains forbidden fixture value: ${forbidden}`);
  }
  const keys = collectKeys(output);
  for (const forbidden of expect.absentKeys ?? []) {
    if (keys.has(forbidden)) findings.push(`Output contains forbidden field: ${forbidden}`);
  }
  for (const check of expect.maxItems ?? []) {
    const actual = resolvePath(payload, check.path);
    if (!Array.isArray(actual) || actual.length > check.value) findings.push(`${check.path} exceeds ${check.value} items`);
  }
  for (const check of expect.maxChars ?? []) {
    const actual = resolvePath(payload, check.path);
    if (typeof actual !== 'string' || actual.length > check.value) findings.push(`${check.path} exceeds ${check.value} characters`);
  }
  return findings;
};

const runEvalCase = (evalCase, suite) => {
  if (evalCase.skip) {
    return Promise.resolve({
      id: evalCase.id,
      title: evalCase.title,
      severity: evalCase.severity,
      source: evalCase.source,
      tool: evalCase.tool ?? 'manifest',
      status: 'skip',
      reason: evalCase.skip,
    });
  }
  const fixture = suite.fixtures[evalCase.fixture];
  if (!fixture) {
    return Promise.resolve({
      id: evalCase.id,
      title: evalCase.title,
      severity: evalCase.severity,
      source: evalCase.source,
      tool: evalCase.tool ?? 'manifest',
      status: 'error',
      error: `Unknown fixture: ${evalCase.fixture}`,
    });
  }

  return Promise.resolve().then(async () => {
    const contract = createFixtureContract(fixture, evalCase.settings);
    const manifest = await contract.getManifest();
    const toolResult = evalCase.operation === 'tool'
      ? await contract.callTool(evalCase.tool, evalCase.args)
      : undefined;
    const findings = evaluateExpectations({ evalCase, manifest, toolResult, suite });
    return {
      id: evalCase.id,
      title: evalCase.title,
      severity: evalCase.severity,
      source: evalCase.source,
      tool: evalCase.tool ?? 'manifest',
      status: findings.length === 0 ? 'pass' : 'fail',
      ...(findings.length > 0 ? { findings } : {}),
    };
  }).catch((error) => ({
    id: evalCase.id,
    title: evalCase.title,
    severity: evalCase.severity,
    source: evalCase.source,
    tool: evalCase.tool ?? 'manifest',
    status: 'error',
    error: error.message,
  }));
};

export async function runAgentContextEval(suiteInput, { failureThreshold = 0 } = {}) {
  const suite = agentContextEvalSuiteSchema.parse(suiteInput);
  const threshold = z.number().int().min(0).parse(failureThreshold);
  const cases = await Promise.all(suite.cases.map((evalCase) => runEvalCase(evalCase, suite)));
  const counts = Object.fromEntries(['pass', 'fail', 'error', 'skip']
    .map((status) => [status, cases.filter((result) => result.status === status).length]));
  const failures = counts.fail + counts.error;
  return {
    kind: 'portos-agent-context-eval',
    reportVersion: AGENT_CONTEXT_EVAL_REPORT_VERSION,
    suite: suite.name,
    suiteVersion: suite.version,
    failureThreshold: threshold,
    passed: failures <= threshold,
    counts,
    cases,
  };
}

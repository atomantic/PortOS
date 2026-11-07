import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalStringify } from './objects.js';

// Guards the handoff corpus for docs/plans/2026-11-07-native-usage-model-attribution.md.
// The resolver below is a reference for the proposed contract, not production code:
// expected values in the fixtures are hand-authored, so it catches an arithmetic
// slip or order-dependent outcome in them. Stay free of production native-usage
// imports: #15031 owns those modules and this corpus must not constrain them.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures/nativeUsageModelAttribution/v1');
const load = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const contract = load('contract.json');
const corpora = { claude: load('claude.json'), grok: load('grok.json') };
const projections = load('projection.json');
// A literal path, so the test memo re-runs this file when the record changes.
const DECISION_RECORD_PATH = join(here, '../../docs/plans/2026-11-07-native-usage-model-attribution.md');
const decisionRecord = readFileSync(DECISION_RECORD_PATH, 'utf8');

const sha = (value) => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const LABEL = new RegExp(contract.labelPattern);
const validLabel = (value) => typeof value === 'string' && LABEL.test(value);
const NEW_CAPABILITY = 'model-attribution-v1';

/** Join-semilattice over one identity's evidence, so copies fold in any order or grouping. */
const CONFLICT = { kind: 'model-conflict' };
const LOW_RANK = { 'report-without-model-capability': 0, 'model-missing': 1, 'model-sentinel': 2 };
const rank = ({ kind }) => LOW_RANK[kind] ?? 3;
const join2 = (a, b) => {
  if (canonicalStringify(a) === canonicalStringify(b)) return a;
  if (a.kind === CONFLICT.kind || b.kind === CONFLICT.kind) return CONFLICT;
  if (rank(a) === 3 && rank(b) === 3) return CONFLICT;
  return rank(a) > rank(b) ? a : b;
};
const fold = (evidence) => evidence.reduce(join2, { kind: 'report-without-model-capability' });

function claudeEvidence(model) {
  if (model === undefined || model === null || (typeof model === 'string' && !model.trim())) return { kind: 'model-missing' };
  if (contract.sentinels.includes(model)) return { kind: 'model-sentinel' };
  return validLabel(model) ? { kind: 'attributed', label: model } : { kind: 'model-label-invalid' };
}

const GROK_COUNTERS = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'modelCalls'];
const validGrokCounters = (record) => GROK_COUNTERS.every((field) => counter(record?.[field]))
  && record.totalTokens === record.inputTokens + record.outputTokens
  && record.cachedReadTokens <= record.inputTokens && record.reasoningTokens <= record.outputTokens;

function grokEvidence(turn, { maxRowsPerRecord }) {
  const usage = turn.modelUsage;
  if (usage === undefined || usage === null) return { kind: 'model-missing' };
  if (typeof usage !== 'object' || Array.isArray(usage)) return { kind: 'model-rows-invalid' };
  const entries = Object.entries(usage);
  if (!entries.length) return { kind: 'model-missing' };
  if (entries.some(([label]) => !validLabel(label))) return { kind: 'model-label-invalid' };
  if (entries.length > maxRowsPerRecord) return { kind: 'model-rows-invalid' };
  if (!entries.every(([, row]) => validGrokCounters(row))) return { kind: 'model-rows-invalid' };
  const reconciles = GROK_COUNTERS.every((field) => entries.reduce((sum, [, row]) => sum + row[field], 0) === turn[field]);
  if (!reconciles) return { kind: 'model-sum-mismatch' };
  const rows = entries.map(([label, row]) => [label, ...GROK_COUNTERS.map((field) => row[field])]).sort(([a], [b]) => (a < b ? -1 : 1));
  return { kind: 'attributed', rows };
}

// Mirrors the accepted-record rules of unionNativeClaudeRecords / unionNativeGrokRecords.
const CLAUDE_USAGE = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
function claudeProvider(copies) {
  const read = copies.map(({ entry }) => ({ values: CLAUDE_USAGE.map((field) => entry.message.usage[field]), request: entry.requestId ?? null, final: Boolean(entry.message.stop_reason), at: entry.timestamp ?? null }));
  if (read.some(({ values }) => !values.every(counter))) return { finding: 'missing-record-fields' };
  if (new Set(read.map(({ request, values }) => canonicalStringify([request, values[0], values[2], values[3]]))).size !== 1) return { finding: 'conflicting-records' };
  const finals = read.filter(({ final }) => final);
  if (!finals.length) return { finding: 'unfinalized-records' };
  const output = finals[0].values[1];
  if (finals.some(({ values }) => values[1] !== output) || read.some(({ values }) => values[1] > output)
    || (!finals[0].request && read.some(({ values }) => values[1] !== output))) return { finding: 'conflicting-records' };
  if (!read.some(({ at }) => at)) return { finding: 'undated-records' };
  return { values: finals[0].values };
}

const validSnapshot = ({ session, turns }) => validGrokCounters(session) && session.turnCount === turns.length
  && turns.every((turn) => validGrokCounters(turn) && turn.turnCount === 1)
  && GROK_COUNTERS.every((field) => turns.reduce((sum, turn) => sum + turn[field], 0) === session[field]);

function grokProvider(copies) {
  if (copies.some(({ valid }) => !valid)) return { finding: 'conflicting-records' };
  const fingerprint = ({ turn }) => canonicalStringify([GROK_COUNTERS.map((field) => turn[field]), turn.endedAt ?? null]);
  // The reader tombstones an undated turn, so the cross-report union sees a conflict.
  if (new Set(copies.map(fingerprint)).size !== 1 || !copies[0].turn.endedAt) return { finding: 'conflicting-records' };
  return { values: GROK_COUNTERS.map((field) => copies[0].turn[field]) };
}

const bucketOf = {
  claude: ([tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens]) => ({ tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, totalTokens: tokensIn + tokensOut + cacheReadTokens + cacheWriteTokens }),
  grok: ([tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, modelCalls]) => ({ tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, modelCalls }),
};
const add = (target, key, bucket) => {
  const prior = target[key];
  target[key] = prior ? Object.fromEntries(Object.entries(bucket).map(([field, value]) => [field, prior[field] + value])) : bucket;
};

const flatten = {
  claude: (scenario) => scenario.reports.flatMap(({ capability, entries }) => entries.map((entry) => ({ capability, entry, identity: entry.message.id }))),
  grok: (scenario) => scenario.reports.flatMap(({ capability, snapshots }) => snapshots.flatMap((snapshot) => {
    const valid = validSnapshot(snapshot);
    return snapshot.turns.map((turn) => ({ capability, turn, valid, identity: `${snapshot.sessionId}/${turn.turnNumber}` }));
  })),
};
const recordKeyOf = {
  claude: (identity) => sha(['portos-native-record/1', 'claude', identity]),
  grok: (identity) => {
    const [session, turn] = identity.split('/');
    return sha(['portos-grok-session-turn/1', session, Number(turn)]);
  },
};

function resolve(family, copies, limits) {
  const identities = new Map();
  for (const copy of copies) identities.set(copy.identity, [...(identities.get(copy.identity) ?? []), copy]);
  const provider = family === 'claude' ? claudeProvider : grokProvider;
  const evidenceOf = (copy) => {
    if (copy.capability !== NEW_CAPABILITY) return { kind: 'report-without-model-capability' };
    return family === 'claude' ? claudeEvidence(copy.entry.message.model) : grokEvidence(copy.turn, limits);
  };
  const accepted = [];
  const refusedRecords = [];
  const refused = {};
  for (const [identity, group] of identities) {
    const recordKey = recordKeyOf[family](identity);
    const { finding, values } = provider(group);
    const grokFields = family === 'grok' ? { incomplete: !finding && group.some(({ capability, turn }) => capability === NEW_CAPABILITY && turn.usageIsIncomplete === true) } : {};
    if (finding) {
      refused[finding] = (refused[finding] ?? 0) + 1;
      refusedRecords.push({ identity, recordKey, outcome: 'refused', finding, ...grokFields });
    } else accepted.push({ identity, recordKey, values, evidence: fold(group.map(evidenceOf)), grokFields });
  }
  const labelsOf = ({ kind, label, rows }) => (kind !== 'attributed' ? [] : label ? [label] : rows.map(([name]) => name));
  const kept = new Set([...new Set(accepted.flatMap(({ evidence }) => labelsOf(evidence)))].sort().slice(0, limits.maxLabelsPerProjection));

  const models = {};
  const unknown = {};
  const unallocated = {};
  const totals = {};
  const records = [...refusedRecords];
  for (const { identity, recordKey, values, evidence, grokFields } of accepted) {
    const outcome = labelsOf(evidence).every((label) => kept.has(label)) ? evidence : { kind: 'model-label-limit' };
    const bucket = bucketOf[family](values);
    add(totals, 'all', bucket);
    if (outcome.kind === 'attributed') {
      if (family === 'claude') add(models, outcome.label, bucket);
      else for (const [label, ...rowValues] of outcome.rows) add(models, label, bucketOf.grok(rowValues));
      records.push({ identity, recordKey, outcome: 'attributed', ...(family === 'claude' ? { label: outcome.label } : { rows: outcome.rows }), ...grokFields });
    } else {
      add(contract.unknownReasons.includes(outcome.kind) ? unknown : unallocated, outcome.kind, bucket);
      records.push({ identity, recordKey, outcome: outcome.kind, ...grokFields });
    }
  }
  records.sort((a, b) => (a.recordKey < b.recordKey ? -1 : 1));
  const result = { records, providerTotals: totals.all ?? null, models, unknown, unallocated, refused };
  if (family === 'grok') result.incompleteRecords = records.filter(({ incomplete }) => incomplete).length;
  result.attributionHash = sha([contract.hashScheme, family, records.map(({ identity, ...rest }) => rest)]);
  return result;
}

const permutations = (list) => (list.length < 2 ? [list]
  : list.flatMap((item, index) => permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])));

const hasExactKeys = (value, keys) => canonicalStringify(Object.keys(value).sort()) === canonicalStringify([...keys].sort());
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

/** Allow-list the input shapes, so no transcript text, path or account field can enter the corpus. */
const validInput = {
  claude: ({ entries }) => entries.every((entry) => onlyKeys(entry, ['type', 'version', 'requestId', 'timestamp', 'message'])
    && entry.type === 'assistant' && /^req-\d+$/.test(entry.requestId ?? 'req-0')
    && onlyKeys(entry.message, ['id', 'model', 'stop_reason', 'usage']) && /^msg-\d+$/.test(entry.message.id)
    && onlyKeys(entry.message.usage, CLAUDE_USAGE)),
  grok: ({ snapshots }) => snapshots.every(({ sessionId, session, turns, ...rest }) => /^session-[a-z]$/.test(sessionId)
    && onlyKeys(rest, ['updatedAt']) && onlyKeys(session, [...GROK_COUNTERS, 'costUsdTicks', 'turnCount', 'primaryModelId', 'modelUsage', 'usageIsIncomplete'])
    && turns.every((turn) => onlyKeys(turn, [...GROK_COUNTERS, 'turnNumber', 'endedAt', 'costUsdTicks', 'costIsPartial', 'turnCount', 'primaryModelId', 'modelUsage', 'usageIsIncomplete']))),
};
const hasModelEvidence = {
  claude: ({ entries }) => entries.some(({ message }) => 'model' in message),
  grok: ({ snapshots }) => snapshots.some(({ turns }) => turns.some((turn) => 'modelUsage' in turn || 'primaryModelId' in turn)),
};

const BUCKET_FIELDS = { claude: 5, grok: 7 };
const sumBuckets = (buckets) => {
  const total = {};
  for (const bucket of buckets) add(total, 'all', bucket);
  return total.all ?? null;
};

describe('native usage model attribution corpus', () => {
  for (const [family, corpus] of Object.entries(corpora)) {
    describe(family, () => {
      it('allow-lists structure and keeps old reports free of model evidence', () => {
        expect(corpus).toMatchObject({ fixtureVersion: 1, family, syntheticOnly: true });
        for (const scenario of corpus.scenarios) {
          expect(onlyKeys(scenario, ['name', 'covers', 'limits', 'reports', 'expect']), scenario.name).toBe(true);
          for (const report of scenario.reports) {
            expect([NEW_CAPABILITY, 'none'], scenario.name).toContain(report.capability);
            expect(validInput[family](report), scenario.name).toBe(true);
            if (report.capability === 'none') expect(hasModelEvidence[family](report), scenario.name).toBe(false);
          }
        }
      });

      it.each(corpus.scenarios.map((scenario) => [scenario.name, scenario]))('%s', (_name, scenario) => {
        const { expect: expected } = scenario;
        // Every copy order must reach the hand-authored outcome, byte for byte.
        const copies = flatten[family](scenario);
        expect(copies.length).toBeLessThanOrEqual(6);
        const limits = { ...contract.limits, ...scenario.limits };
        for (const order of permutations(copies)) expect(resolve(family, order, limits)).toEqual(expected);

        // The buckets must partition the accepted provider total, never move or invent tokens.
        const buckets = [expected.models, expected.unknown, expected.unallocated].flatMap(Object.values);
        expect(sumBuckets(buckets)).toEqual(expected.providerTotals);
        for (const bucket of [...buckets, ...(expected.providerTotals ? [expected.providerTotals] : [])]) {
          expect(Object.keys(bucket)).toHaveLength(BUCKET_FIELDS[family]);
          // Claude's fields are disjoint; Grok's cache and reasoning are inside input and output.
          const { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, totalTokens, reasoningTokens } = bucket;
          if (family === 'claude') expect(totalTokens).toBe(tokensIn + tokensOut + cacheReadTokens + cacheWriteTokens);
          else {
            expect(totalTokens).toBe(tokensIn + tokensOut);
            expect(cacheReadTokens).toBeLessThanOrEqual(tokensIn);
            expect(reasoningTokens).toBeLessThanOrEqual(tokensOut);
          }
        }

        expect(Object.keys(expected.unknown).every((reason) => contract.unknownReasons.includes(reason))).toBe(true);
        expect(Object.keys(expected.unallocated).every((reason) => contract.unallocatedReasons.includes(reason))).toBe(true);
        expect(Object.keys(expected.refused).every((finding) => contract.providerFindings.includes(finding))).toBe(true);

        // A refused label must not survive anywhere in the outcome.
        const outcome = JSON.stringify(expected);
        for (const rejected of corpus.rejectedLabelExamples) expect(outcome).not.toContain(rejected);
        for (const label of Object.keys(expected.models)) expect(validLabel(label), label).toBe(true);
      });
    });
  }

  it('covers every case the handoff requires', () => {
    const covered = new Set(Object.values(corpora).flatMap(({ scenarios }) => scenarios.flatMap(({ covers }) => covers)));
    for (const required of contract.requiredCoverage) expect([...covered]).toContain(required);
    const reasons = [...contract.unknownReasons, ...contract.unallocatedReasons];
    const exercised = Object.values(corpora).flatMap(({ scenarios }) => scenarios.flatMap(({ expect: e }) => [...Object.keys(e.unknown), ...Object.keys(e.unallocated), ...Object.keys(e.refused)]));
    for (const reason of [...reasons, ...contract.providerFindings]) expect(exercised).toContain(reason);
  });

  it('folds evidence order-independently across any grouping', () => {
    const domain = [
      { kind: 'report-without-model-capability' }, { kind: 'model-missing' }, { kind: 'model-sentinel' },
      { kind: 'model-label-invalid' }, { kind: 'model-sum-mismatch' }, { kind: 'model-rows-invalid' },
      { kind: 'attributed', label: 'example-a' }, { kind: 'attributed', label: 'example-b' },
      { kind: 'attributed', rows: [['example-a', 1, 1, 0, 0, 0, 2, 1]] }, CONFLICT,
    ];
    for (const a of domain) {
      expect(join2(a, a)).toEqual(a);
      expect(join2(domain[0], a)).toEqual(a);
      expect(join2(a, CONFLICT)).toEqual(CONFLICT);
      for (const b of domain) {
        expect(join2(a, b)).toEqual(join2(b, a));
        for (const c of domain) expect(join2(join2(a, b), c)).toEqual(join2(a, join2(b, c)));
      }
    }
  });
});

const REASON_TOKENS = contract.unknownReasons.filter((reason) => reason !== 'report-without-model-capability').concat(contract.unallocatedReasons);
const CLAUDE_RECORD_V1 = ['recordKey', 'requestKey', 'values', 'final', 'conflict', 'inconsistent', 'at'];
const GROK_RECORD_V1 = ['recordKey', 'values', 'costUsdTicks', 'costConflict', 'conflict', 'inconsistent', 'at'];
const COUNTER_COLUMNS = 7;

function grokRowsRefusal(rows, record, labelCount) {
  if (!rows.every((row) => Array.isArray(row) && row.length === COUNTER_COLUMNS + 1 && row.every(counter))) return 'invalid-model-token';
  if (rows.some(([index]) => index >= labelCount)) return 'label-index-out-of-range';
  if (rows.some(([index], position) => position > 0 && index <= rows[position - 1][0])) return 'rows-not-canonical';
  const wellFormed = rows.every(([, input, output, cached, , reasoning, total]) => total === input + output && cached <= input && reasoning <= output);
  const reconciles = record.values.every((value, column) => rows.reduce((sum, row) => sum + row[column + 1], 0) === value);
  return wellFormed && reconciles ? null : 'rows-do-not-reconcile';
}

/** Reference refusal rules for the proposed v2 projection; v1 stays strict and label-free. */
function projectionRefusal(family, projection) {
  const recordKeys = family === 'claude' ? CLAUDE_RECORD_V1 : GROK_RECORD_V1;
  if (projection.version === 1) {
    return hasExactKeys(projection, ['version', 'identityScheme', 'truncated', 'records'])
      && projection.records.every((record) => hasExactKeys(record, recordKeys)) ? null : 'fields-not-exact';
  }
  const fields = family === 'claude' ? [...recordKeys, 'model'] : [...recordKeys, 'model', 'incomplete'];
  if (!hasExactKeys(projection, ['version', 'identityScheme', 'truncated', 'modelLabels', 'records'])
    || !projection.records.every((record) => hasExactKeys(record, fields))) return 'fields-not-exact';
  const labels = projection.modelLabels;
  if (!labels.every(validLabel)) return 'invalid-label';
  const used = new Set();
  for (const record of projection.records) {
    const { model } = record;
    if (typeof model === 'string') {
      if (!REASON_TOKENS.includes(model)) return 'invalid-model-token';
    } else if (family === 'claude') {
      if (!counter(model)) return 'invalid-model-token';
      if (model >= labels.length) return 'label-index-out-of-range';
      used.add(model);
    } else {
      if (!Array.isArray(model)) return 'invalid-model-token';
      const refusal = grokRowsRefusal(model, record, labels.length);
      if (refusal) return refusal;
      for (const [index] of model) used.add(index);
    }
  }
  const canonical = labels.length <= contract.limits.maxLabelsPerProjection && used.size === labels.length
    && labels.every((label, index) => index === 0 || labels[index - 1] < label);
  return canonical ? null : 'labels-not-canonical';
}

describe('proposed projection examples', () => {
  for (const family of ['claude', 'grok']) {
    it.each(projections[family].map((example) => [example.name, example]))(`${family}: %s`, (_name, { accept, reason, projection }) => {
      expect(projectionRefusal(family, projection)).toBe(accept ? null : reason);
    });
  }

  it('refuses more labels than the projection limit', () => {
    const labels = Array.from({ length: contract.limits.maxLabelsPerProjection + 1 }, (_, index) => `example-${String(index).padStart(3, '0')}`);
    const records = labels.map((_, index) => ({ recordKey: sha(index), requestKey: null, values: [1, 1, 0, 0], final: true, conflict: false, inconsistent: false, at: null, model: index }));
    expect(projectionRefusal('claude', { version: 2, identityScheme: 'sha256-native-record/1', truncated: false, modelLabels: labels, records })).toBe('labels-not-canonical');
    expect(projectionRefusal('claude', { version: 2, identityScheme: 'sha256-native-record/1', truncated: false, modelLabels: labels.slice(1), records: records.slice(1).map((record, index) => ({ ...record, model: index })) })).toBeNull();
  });
});

describe('committed artifacts stay synthetic and in step', () => {
  const PRIVATE_SHAPES = [/\/Users\//, /\/home\//, /[A-Za-z]:\\/, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/, /\bsk-[A-Za-z0-9]{8,}/, /\.ts\.net\b/];

  it('carries no private value shape outside its declared refused examples', () => {
    const rejected = [...new Set(Object.values(corpora).flatMap(({ rejectedLabelExamples }) => rejectedLabelExamples))];
    const scrub = (text) => rejected.reduce((rest, example) => rest.split(example).join(''), text);
    const artifacts = [contract, projections, ...Object.values(corpora)].map((value) => scrub(JSON.stringify(value)));
    for (const text of [...artifacts, decisionRecord]) {
      for (const shape of PRIVATE_SHAPES) expect(shape.test(text), String(shape)).toBe(false);
    }
  });

  it('names every reason, limit and the label grammar in the decision record', () => {
    expect(DECISION_RECORD_PATH.split('\\').join('/').endsWith(contract.decisionRecord)).toBe(true);
    for (const token of [...contract.unknownReasons, ...contract.unallocatedReasons, ...contract.providerFindings, contract.hashScheme]) {
      expect(decisionRecord).toContain(`\`${token}\``);
    }
    expect(decisionRecord).toContain(contract.labelPattern);
    const { maxLabelLength, maxLabelsPerProjection, maxRowsPerRecord } = contract.limits;
    expect(decisionRecord).toMatch(new RegExp(`at most\\s+${maxLabelLength}\\s+characters`));
    expect(decisionRecord).toMatch(new RegExp(`at most\\s+${maxLabelsPerProjection}\\s+distinct labels`));
    expect(decisionRecord).toMatch(new RegExp(`at most\\s+${maxRowsPerRecord}\\s+rows`));
  });
});

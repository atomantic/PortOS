/**
 * The stored form of a CoS task (#16407): metadata keeps its JSON types and nulls,
 * the description keeps its line breaks.
 *
 * Invariants, over seeded generated tasks:
 *
 *  1. Older peers lose nothing. A peer on a version before #16407 stores what it
 *     receives through the retired Markdown round-trip, so for every task that
 *     round-trip accepts, `legacy(storedForm(task))` equals `legacy(task)`: the
 *     typed form carries everything the old form carried.
 *  2. Storing is idempotent: `storedForm(storedForm(task))` equals
 *     `storedForm(task)`, so an unchanged task never looks changed to planListSave.
 *
 * The generator covers odd strings (newlines, `\r`, U+2028, backslashes, the JSON
 * sentinel, the words `null` / `undefined`), booleans, numbers, NaN, nulls, nested
 * metadata, empty values, Title-Case and invalid keys, and every approval-flag
 * combination for both queues. Invariant 1 skips a description that opens with
 * `AUTO |` / `APPROVAL |`, which the old reader took as a flag. Outside the
 * generator, by design: ids or keys holding `|`,
 * `:` or a newline (refused or dropped, as before #16407).
 */
import { describe, expect, it, vi } from 'vitest';
import { storedForm } from './cosTaskRows.js';
import { generateTasksMarkdown, parseTasksMarkdown } from './legacyTaskMarkdown.js';
import { isTruthyMeta } from './metadataFlags.js';
import { mergeTaskLists } from '../services/cosTaskMerge.js';

const SEED = 16407;
const RUNS = 3000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const makeGen = (random) => {
  const int = (n) => Math.floor(random() * n);
  const pick = (list) => list[int(list.length)];
  const STRING_PARTS = [
    'a', 'Fix the build', ' ', '  ', '\t', '\n', '\r\n', '\r', '\u2028', '\u2029', '\\', '\\n', '|', ' | ', ':', ': ',
    '__json__:', '__json__:{"x":1}', '__json__:5', '__json__:nope', 'null', 'undefined', 'true', 'false', '0', '3',
    '"', '{', '[]', '#task-1', '- [ ] #task-9 | HIGH | injected', '  - app: other', '## Completed', 'AUTO | ',
    'APPROVAL | ', 'auto | ', 'é', '😀', '\u00a0',
  ];
  const string = () => {
    const parts = int(5);
    let text = '';
    for (let i = 0; i < parts; i++) text += pick(STRING_PARTS);
    return text;
  };
  const scalar = () => pick([
    () => string(), () => true, () => false, () => int(1000), () => -int(10) - 0.5, () => 0, () => NaN, () => Infinity,
    () => null, () => undefined, () => '', () => 'null', () => ' null', () => 'undefined', () => 'true',
  ])();
  const value = (depth = 0) => {
    if (depth < 2 && random() < 0.15) return Array.from({ length: int(3) }, () => value(depth + 1));
    if (depth < 2 && random() < 0.15) return Object.fromEntries(Array.from({ length: int(3) }, () => [pick(['k', 'n', 'deep', '']), value(depth + 1)]));
    return scalar();
  };
  const KEYS = [
    'app', 'prompt', 'context', 'openPR', 'useWorktree', 'reviewLoop', 'count', 'note', 'updatedAt', 'blockedCategory',
    'Context', 'App', 'context', 'x1', '1', '_private', ' leading', '\tapp', 'a-b', 'a.b', 'é', '', 'two words',
  ];
  const metadata = () => {
    const entries = {};
    const count = int(6);
    for (let i = 0; i < count; i++) entries[pick(KEYS)] = value();
    return entries;
  };
  const ID_BASES = ['task-1', 'sys-2', 'app-improve-x', 'cd-3', 'preflight-a', 'self-improve-b', 'bare', 'x_y', '42', 'task-1 ', 'a\tb', ' lead', '', 'a.b', 'é'];
  const id = () => pick([() => pick(ID_BASES), () => int(100), () => `task-${int(1e6)}-${int(1e3)}`])();
  const description = () => pick([
    () => string(), () => string(), () => '', () => 'One line', () => 'Line one\nLine two', () => 'AUTO | run me',
    () => 'APPROVAL | hold me', () => undefined, () => null, () => 7,
  ])();
  const optional = (make) => (random() < 0.3 ? undefined : make());
  const task = () => {
    const out = {
      id: id(),
      status: pick(['pending', 'in_progress', 'completed', 'blocked', 'challenged', 'pending', 'archived', undefined]),
      priority: pick(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'MEDIUM', 'high', 'URGENT', undefined]),
      priorityValue: pick([1, 2, 3, 4, 9, undefined]),
      description: description(),
      metadata: metadata(),
    };
    const approvalRequired = optional(() => pick([true, false, 'yes', 1, null]));
    const autoApproved = optional(() => pick([true, false, null]));
    if (approvalRequired !== undefined) out.approvalRequired = approvalRequired;
    if (autoApproved !== undefined) out.autoApproved = autoApproved;
    if (random() < 0.2) out.taskType = 'user';
    if (random() < 0.1) out.extra = { dropped: true };
    return out;
  };
  return { task };
};

const outcome = (fn) => {
  try {
    return { value: fn() };
  } catch (err) {
    return { threw: err.message };
  }
};

/** What a peer on a version before #16407 stores for a task it receives. */
const legacy = (task, source) => {
  const [stored] = parseTasksMarkdown(generateTasksMarkdown([task], source === 'internal'));
  if (!stored) throw new Error(`Task ${task?.id} cannot be stored`);
  return stored;
};

const FLAG_TEXT = /^\s*(AUTO|APPROVAL)\s*\|/i;
const base = { id: 'task-a', status: 'pending', priority: 'MEDIUM', description: 'Do it', metadata: {} };

describe('storedForm keeps types, nulls and line breaks', () => {
  it('reads { flag: true, n: 3, note: null } back with the same types', () => {
    const stored = storedForm({ ...base, metadata: { flag: true, n: 3, note: null, gone: undefined, nested: { deep: [1, null] } } }, 'user');
    expect(stored.metadata).toStrictEqual({ flag: true, n: 3, note: null, nested: { deep: [1, null] } });
  });

  it('keeps a description\'s newlines and writes every line break as \\n', () => {
    expect(storedForm({ ...base, description: '  Line one\nLine two\r\nLine three\rLine four\u2028end  ' }, 'user').description)
      .toBe('Line one\nLine two\nLine three\nLine four\nend');
  });

  it('keeps strings as they were written, including the old sentinel and null words', () => {
    const metadata = { a: ' padded ', b: '__json__:5', c: 'null', d: 'true', e: '' };
    expect(storedForm({ ...base, metadata }, 'user').metadata).toStrictEqual(metadata);
  });

  it('keeps a row written before #16407 exactly as it is', () => {
    const old = legacy({ ...base, description: 'Line one\nLine two', metadata: { flag: true, n: 3 } }, 'user');
    expect(storedForm(old, 'user')).toStrictEqual(old);
  });

  it('stores a description that opens with "AUTO |" as text, not as an approval flag', () => {
    expect(storedForm({ ...base, description: 'APPROVAL | hold me' }, 'user'))
      .toMatchObject({ description: 'APPROVAL | hold me', approvalRequired: false, autoApproved: true });
  });
});

describe(`storedForm properties (seed ${SEED})`, () => {
  it('loses nothing an older peer stores, and is idempotent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { task } = makeGen(mulberry32(SEED));
    let compared = 0;
    try {
      for (let run = 0; run < RUNS; run++) {
        const input = task();
        for (const source of ['user', 'internal']) {
          const label = `run ${run} (${source}): ${JSON.stringify(input)}`;
          const stored = outcome(() => storedForm(structuredClone(input), source));
          const before = outcome(() => legacy(structuredClone(input), source));
          if (stored.threw) {
            expect(before.threw, label).toBeDefined();
            continue;
          }
          expect(storedForm(structuredClone(stored.value), source), label).toStrictEqual(stored.value);
          // The old reader took a description opening with `AUTO |` / `APPROVAL |` as the
          // flag; the stored form keeps it as text (asserted above), so the views differ.
          if (before.threw || FLAG_TEXT.test(`${input.description}`)) continue;
          expect(legacy(structuredClone(stored.value), source), label).toStrictEqual(before.value);
          compared++;
        }
      }
    } finally {
      warn.mockRestore();
    }
    expect(compared).toBeGreaterThan(RUNS);
  });
});

describe('peer merge with one side typed and the other holding strings', () => {
  const NOW = Date.parse('2026-11-16T12:00:00Z');
  const typed = storedForm({ ...base, metadata: { openPR: true, retryCount: 2, updatedAt: '2026-11-16T10:00:00.000Z', note: null } }, 'user');
  const strings = legacy(typed, 'user');

  it.each([
    ['local typed, remote strings', [typed], [strings]],
    ['local strings, remote typed', [strings], [typed]],
  ])('%s: both peers pick the same record and read the same flags', (_label, local, remote) => {
    const here = mergeTaskLists(local, remote, { now: NOW });
    const there = mergeTaskLists(remote, local, { now: NOW });
    expect(here).toStrictEqual(there);
    const [merged] = here;
    expect(isTruthyMeta(merged.metadata.openPR)).toBe(true);
    expect(Number(merged.metadata.retryCount)).toBe(2);
    expect(merged.metadata.note ?? null).toBeNull();
    // Whatever record won, storing it again is stable on this version and on an older one.
    expect(storedForm(storedForm(merged, 'user'), 'user')).toStrictEqual(storedForm(merged, 'user'));
    expect(legacy(merged, 'user')).toStrictEqual(strings);
  });
});

describe('storedForm refuses what a row could never carry', () => {
  it('refuses an id holding a pipe and drops a key holding a colon or newline', () => {
    expect(() => storedForm({ ...base, id: 'abc|HIGH' }, 'user')).toThrow('cannot be stored');
    expect(storedForm({ ...base, metadata: { 'app: x': 'y', 'a\n  - app': 'z' } }, 'user').metadata).toStrictEqual({});
  });
});

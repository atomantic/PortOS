/**
 * Invariant: `storedForm(task, source)` returns exactly what writing the task as
 * one row of the retired Markdown file and reading it back returned,
 * `parseTasksMarkdown(generateTasksMarkdown([task], source === 'internal'))[0]`,
 * including throwing where that round-trip lost the row (#16407 part 1).
 *
 * The generator covers the shapes the round-trip was lossy on: scalar metadata
 * (booleans, numbers, NaN), nullish values, nested objects/arrays, empty strings,
 * strings holding newlines, backslashes, `\r`, U+2028, the JSON sentinel, the words
 * `null` / `undefined`, leading/trailing whitespace, descriptions with newlines or a
 * leading `AUTO |` / `APPROVAL |`, Title-Case and invalid metadata keys, ids with
 * and without a registered prefix, numeric ids, unrepresentable statuses and
 * priorities, and every approval-flag combination for both queues.
 *
 * Outside the generator, by design: ids or keys holding `|`, `:` or a newline
 * (refused or dropped, see `storedId` / `storedKey`; asserted separately below),
 * and non-JSON values (functions, symbols), which no task carries.
 */
import { describe, expect, it, vi } from 'vitest';
import { storedForm } from './cosTaskRows.js';
import { generateTasksMarkdown, parseTasksMarkdown } from './legacyTaskMarkdown.js';

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

const viaMarkdown = (task, source) => {
  const [stored] = parseTasksMarkdown(generateTasksMarkdown([task], source === 'internal'));
  if (!stored) throw new Error(`Task ${task?.id} cannot be stored`);
  return stored;
};

describe('storedForm equals the retired Markdown round-trip', () => {
  it(`matches it on ${RUNS} generated tasks per queue (seed ${SEED})`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { task } = makeGen(mulberry32(SEED));
    let stored = 0;
    let refused = 0;
    try {
      for (let run = 0; run < RUNS; run++) {
        const input = task();
        for (const source of ['user', 'internal']) {
          warn.mockClear();
          const expected = outcome(() => viaMarkdown(structuredClone(input), source));
          const expectedWarnings = warn.mock.calls.map(([line]) => line.replace(' markdown', ''));
          warn.mockClear();
          const actual = outcome(() => storedForm(structuredClone(input), source));
          const actualWarnings = warn.mock.calls.map(([line]) => line);
          const label = `run ${run} (${source}): ${JSON.stringify(input)}`;
          expect(actual, label).toStrictEqual(expected);
          expect(actualWarnings, label).toEqual(expectedWarnings);
          if (expected.threw) refused++; else stored++;
        }
      }
    } finally {
      warn.mockRestore();
    }
    // The generator must exercise both outcomes, or the comparison proves little.
    expect(stored).toBeGreaterThan(RUNS);
    expect(refused).toBeGreaterThan(50);
  });

  it('keeps the documented example: strings for scalars, no nullish keys, one-line description', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = { id: 'task-a', status: 'pending', priority: 'MEDIUM', description: 'Line one\nLine two', metadata: { flag: true, n: 3, note: null } };
    expect(storedForm(input, 'user')).toStrictEqual(viaMarkdown(input, 'user'));
    expect(storedForm(input, 'user')).toMatchObject({ description: 'Line one Line two', metadata: { flag: 'true', n: '3' } });
    warn.mockRestore();
  });
});

describe('storedForm refuses what the round-trip could only mangle', () => {
  const base = { status: 'pending', priority: 'HIGH', description: 'Do it', metadata: {} };

  it('refuses an id holding a pipe instead of re-keying the task under its first segment', () => {
    // The round-trip stored `task-abc` with the id's tail spliced into the description.
    expect(viaMarkdown({ ...base, id: 'abc|HIGH' }, 'user')).toMatchObject({ id: 'task-abc', description: 'HIGH | Do it' });
    expect(() => storedForm({ ...base, id: 'abc|HIGH' }, 'user')).toThrow('cannot be stored');
  });

  it('drops a metadata key holding a colon or newline instead of re-keying its value', () => {
    expect(viaMarkdown({ ...base, id: 'task-1', metadata: { 'app: x': 'y' } }, 'user').metadata).toEqual({ app: 'x: y' });
    expect(storedForm({ ...base, id: 'task-1', metadata: { 'app: x': 'y', 'a\n  - app': 'z' } }, 'user').metadata).toEqual({});
  });
});

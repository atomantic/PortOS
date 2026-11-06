import { describe, expect, it } from 'vitest';
import { persistentMindRecallTerms, selectPersistentMindRecall } from './persistentMindRecall.js';

const mindId = 'example-mind';
const record = (id, content, extra = {}) => ({ id, content, status: 'active', sourceAgentId: mindId, ...extra });
const select = (message, ...candidates) => selectPersistentMindRecall({ message, candidates, mindId }).map((memory) => memory.id);

describe('persistent mind recall gate', () => {
  it.each(['thanks!', 'ok, sounds great', 'What did we decide?', '', null])('treats %j as carrying no recall terms', (message) => {
    expect(persistentMindRecallTerms(message)).toEqual([]);
  });

  it.each([
    ['inflections', 'What did we decide about the zebra migrations?', 'We will migrate the Zebra service in two steps.', true],
    ['a one-term message', 'zebra?', 'Zebra is the code name.', true],
    ['non-English words', 'Où est la bibliothèque municipale ?', 'La bibliothèque municipale a déménagé.', true],
    ['a single incidental overlap', 'How is the zebra weather today?', 'Zebra is the code name.', false],
    ['too little of a long message', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet', 'alpha bravo notes', false],
    ['enough of a long message', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet', 'alpha bravo charlie notes', true],
  ])('handles %s', (_label, message, content, expected) => {
    expect(select(message, record('match', content))).toEqual(expected ? ['match'] : []);
  });

  it('never selects foreign or inactive records, ranks by coverage, and keeps at most three', () => {
    const message = 'zebra migration window rollback';
    expect(select(message,
      record('foreign', 'zebra migration window rollback', { sourceAgentId: 'other-agent' }),
      record('archived', 'zebra migration window rollback', { status: 'archived' }),
      null,
      record('two', 'zebra migration'),
      record('four', 'zebra migration window rollback'),
      record('three', 'zebra migration window'),
      record('also-two', 'window rollback'),
    )).toEqual(['four', 'three', 'two']);
  });
});

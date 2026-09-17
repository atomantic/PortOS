import { describe, it, expect } from 'vitest';
import { toAgentListItem, toAgentListItems, AGENT_LIST_DESCRIPTION_CHARS } from './cosAgentListProjection.js';

const agent = (overrides = {}) => ({
  id: 'agent-001',
  status: 'completed',
  taskId: 'task-1',
  output: ['line one', 'line two'],
  metadata: { taskDescription: 'Fix the thing', model: 'opus', taskApp: 'portos' },
  ...overrides
});

describe('toAgentListItem', () => {
  it('drops the transcript from every listing row', () => {
    expect(toAgentListItem(agent())).not.toHaveProperty('output');
  });

  it('leaves a normal description whole and unflagged', () => {
    const item = toAgentListItem(agent());
    expect(item.metadata.taskDescription).toBe('Fix the thing');
    expect(item.metadata.taskDescriptionTruncated).toBeUndefined();
  });

  it('bounds an over-long description and flags it as clipped', () => {
    // A pasted-prompt description: the case the whole projection exists for.
    const long = 'Refactor the queue. '.repeat(5000);
    const item = toAgentListItem(agent({ metadata: { taskDescription: long } }));

    expect(item.metadata.taskDescription.length).toBeLessThanOrEqual(AGENT_LIST_DESCRIPTION_CHARS);
    expect(long.startsWith(item.metadata.taskDescription.trim())).toBe(true);
    expect(item.metadata.taskDescriptionTruncated).toBe(true);
  });

  it('does not mutate the record it projects — the service copy still feeds the digest whole', () => {
    const long = 'x'.repeat(AGENT_LIST_DESCRIPTION_CHARS + 500);
    const source = agent({ metadata: { taskDescription: long } });
    toAgentListItem(source);
    expect(source.metadata.taskDescription).toHaveLength(long.length);
    expect(source.output).toHaveLength(2);
  });

  it('keeps every other metadata field', () => {
    const long = 'y'.repeat(AGENT_LIST_DESCRIPTION_CHARS + 1);
    const item = toAgentListItem(agent({ metadata: { taskDescription: long, model: 'opus', taskApp: 'portos' } }));
    expect(item.metadata.model).toBe('opus');
    expect(item.metadata.taskApp).toBe('portos');
  });

  it('survives a record with no metadata at all', () => {
    expect(toAgentListItem({ id: 'agent-002' })).toEqual({ id: 'agent-002' });
  });
});

describe('toAgentListItems', () => {
  it('projects every row', () => {
    const items = toAgentListItems([agent(), agent({ id: 'agent-002' })]);
    expect(items).toHaveLength(2);
    expect(items.every(i => !('output' in i))).toBe(true);
  });
});

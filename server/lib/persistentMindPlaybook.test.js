import { describe, expect, it } from 'vitest';
import {
  CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS,
  composePersistentMindInstructions,
  createDefaultPersistentMindPlaybook,
  mergePersistentMindPlaybook,
  normalizePersistentMindPlaybook,
  playbookInstructionBlock,
  persistentMindPlaybookSchema,
} from './persistentMindPlaybook.js';

describe('persistentMindPlaybook', () => {
  it('defaults to the operator-only mode', () => {
    expect(createDefaultPersistentMindPlaybook()).toMatchObject({ mode: 'default', customInstructions: '' });
    expect(normalizePersistentMindPlaybook(null).mode).toBe('default');
    expect(normalizePersistentMindPlaybook({ mode: 'nope' }).mode).toBe('default');
  });

  it('validates and merges playbook patches', () => {
    expect(persistentMindPlaybookSchema.safeParse({ mode: 'continuous-play' }).success).toBe(true);
    expect(persistentMindPlaybookSchema.safeParse({ mode: 'yolo' }).success).toBe(false);
    expect(mergePersistentMindPlaybook({ mode: 'default' }, { mode: 'continuous-play' }).mode).toBe('continuous-play');
  });

  it('composes continuous-play instructions after the operator prompt', () => {
    expect(playbookInstructionBlock({ mode: 'default' })).toBe('');
    const block = playbookInstructionBlock({ mode: 'continuous-play' });
    expect(block).toContain('EXPLORE');
    expect(block).toContain('INVENT');
    expect(block).toBe(CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS);
    const composed = composePersistentMindInstructions('Be concise.', { mode: 'continuous-play' });
    expect(composed.startsWith('Be concise.')).toBe(true);
    expect(composed).toContain('Continuous play');
  });
});

import { describe, expect, it } from 'vitest';
import {
  CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS,
  PERSISTENT_MIND_PLAYBOOK_PHASE_INSTRUCTIONS,
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
    // Observation leads the loop (#7457): a mind looks at the world before
    // it speaks in it, so OBSERVE is the step name the template opens with.
    expect(block).toContain('OBSERVE');
    expect(block).toContain('eidoverse.observe');
    expect(block).toContain('INVENT');
    expect(block).toBe(CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS);
    const composed = composePersistentMindInstructions('Be concise.', { mode: 'continuous-play' });
    expect(composed.startsWith('Be concise.')).toBe(true);
    expect(composed).toContain('Continuous play');
  });

  it('selects the maturity-aware phase template when a valid phase is supplied (#7458)', () => {
    const construct = playbookInstructionBlock({ mode: 'continuous-play' }, 'construct');
    expect(construct).toBe(PERSISTENT_MIND_PLAYBOOK_PHASE_INSTRUCTIONS.construct);
    expect(construct).toContain('PLAYBOOK PHASE — Construct');
    expect(construct).toContain('Phase: Construct');
    expect(construct).not.toBe(CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS);

    for (const phase of ['explore', 'construct', 'maintain', 'coordinate']) {
      const block = playbookInstructionBlock({ mode: 'continuous-play' }, phase);
      expect(block).toBe(PERSISTENT_MIND_PLAYBOOK_PHASE_INSTRUCTIONS[phase]);
    }

    // An unrecognized/omitted phase keeps the general loop rather than throwing.
    expect(playbookInstructionBlock({ mode: 'continuous-play' }, 'not-a-real-phase')).toBe(CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS);

    const composed = composePersistentMindInstructions('Be concise.', { mode: 'continuous-play' }, 'coordinate');
    expect(composed).toContain('PLAYBOOK PHASE — Coordinate');
    expect(composed.startsWith('Be concise.')).toBe(true);
  });

  // The regression #7630 names: the picker's peer signal was reachability,
  // and this template — the text the model actually reads — claimed "peers
  // waiting" with "activity worth your attention". A reachable peer with
  // nothing unread made that fabricated claim the steady state for every
  // mature install. The heading and opening sentence must claim only what
  // `peerContributionsUnread` measured: what ARRIVED since the last look.
  it('claims only the signal that selected it (#7630)', () => {
    const coordinate = PERSISTENT_MIND_PLAYBOOK_PHASE_INSTRUCTIONS.coordinate;
    const opening = coordinate.split('\n\n').slice(0, 2).join(' ');
    expect(opening).not.toMatch(/peers waiting|worth your attention/i);
    expect(opening).toMatch(/since (this mind|you) last (observed|looked)/i);
    expect(opening).toMatch(/arrived|new peer/i);
  });

  it('appends custom instructions after the phase template, not instead of it', () => {
    const block = playbookInstructionBlock({ mode: 'continuous-play', customInstructions: 'Prefer the northern district.' }, 'maintain');
    expect(block).toContain('PLAYBOOK PHASE — Maintain');
    expect(block.endsWith('Prefer the northern district.')).toBe(true);
  });
});

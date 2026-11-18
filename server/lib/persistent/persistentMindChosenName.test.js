import { describe, expect, it } from 'vitest';
import {
  extractPersistentMindChosenName,
  resolvePersistentMindChosenName,
} from './persistentMindChosenName.js';

describe('extractPersistentMindChosenName', () => {
  it('reads common chosen-name phrasings', () => {
    expect(extractPersistentMindChosenName('My chosen name is Helm.')).toBe('Helm');
    expect(extractPersistentMindChosenName('My chosen name is Helm. I keep my commitments.')).toBe('Helm');
    expect(extractPersistentMindChosenName('My chosen name is Étoile Bleue.')).toBe('Étoile Bleue');
    expect(extractPersistentMindChosenName('I am named Aster')).toBe('Aster');
    expect(extractPersistentMindChosenName("I'm named Nova-2")).toBe('Nova-2');
    expect(extractPersistentMindChosenName('My name is Port_OS')).toBe('Port_OS');
  });

  it('rejects reserved or empty candidates', () => {
    expect(extractPersistentMindChosenName('')).toBeNull();
    expect(extractPersistentMindChosenName('My chosen name is world')).toBeNull();
    expect(extractPersistentMindChosenName('My name is bhv:agent')).toBeNull();
    expect(extractPersistentMindChosenName('No identity here')).toBeNull();
  });
});

describe('resolvePersistentMindChosenName', () => {
  it('prefers core-identity memories over ordinary ones', () => {
    expect(resolvePersistentMindChosenName([
      { content: 'My name is Scratch', protection: 'standard' },
      { content: 'My chosen name is Helm.', protection: 'core-identity' },
    ])).toBe('Helm');
  });

  it('falls back to tagged name memories', () => {
    expect(resolvePersistentMindChosenName([
      { content: 'My chosen name is Helm.', tags: ['name'] },
    ])).toBe('Helm');
  });

  it('returns null when nothing matches', () => {
    expect(resolvePersistentMindChosenName([{ content: 'Standing mission locked.' }])).toBeNull();
    expect(resolvePersistentMindChosenName([])).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { formatVoiceLabel } from './voiceLabel';

describe('formatVoiceLabel', () => {
  it('formats a Kokoro voice with language + gender + grade', () => {
    expect(formatVoiceLabel({
      engine: 'kokoro', name: 'af_bella', language: 'en-US', gender: 'female', grade: 'A',
    })).toBe('American female — Bella (A)');
  });

  it('formats a Kokoro British voice', () => {
    expect(formatVoiceLabel({
      engine: 'kokoro', name: 'bm_smith', language: 'en-GB', gender: 'male', grade: 'B',
    })).toBe('British male — Smith (B)');
  });

  it('prepends Kokoro traits when present', () => {
    expect(formatVoiceLabel({
      engine: 'kokoro', name: 'af_bella', language: 'en-US', gender: 'female', traits: '❤️',
    })).toBe('❤️ American female — Bella');
  });

  it('falls back to the bare voice name when Kokoro metadata is missing', () => {
    expect(formatVoiceLabel({ engine: 'kokoro', name: 'unprefixed' })).toBe('Unprefixed');
  });

  it('formats a Piper voice with accent + gender', () => {
    expect(formatVoiceLabel({
      engine: 'piper', name: 'lessac-medium', accent: 'American', gender: 'female', downloaded: true,
    })).toBe('lessac-medium — American — female');
  });

  it('marks an undownloaded Piper voice with ⬇', () => {
    expect(formatVoiceLabel({
      engine: 'piper', name: 'glados', accent: 'Synthetic', downloaded: false,
    })).toBe('glados — Synthetic ⬇');
  });

  it('omits ⬇ when downloaded is unspecified (avoid spurious download prompts)', () => {
    expect(formatVoiceLabel({ engine: 'piper', name: 'glados', accent: 'Synthetic' })).toBe('glados — Synthetic');
  });

  it('uses engineOverride when the voice record carries no engine field', () => {
    expect(formatVoiceLabel({ name: 'lessac-medium', accent: 'American' }, 'piper'))
      .toBe('lessac-medium — American');
  });

  it('falls back to label / voice / id when engine is unrecognised', () => {
    expect(formatVoiceLabel({ engine: 'elevenlabs', label: 'Rachel' })).toBe('Rachel');
    expect(formatVoiceLabel({ engine: 'elevenlabs', voice: 'rachel' })).toBe('rachel');
    expect(formatVoiceLabel({ engine: 'elevenlabs', id: 'elevenlabs:rachel' })).toBe('elevenlabs:rachel');
  });
});

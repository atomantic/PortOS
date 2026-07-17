import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (declared before importing the module under test) ----
// Fixtures are deliberately synthetic — no live-instance identity data (per the
// repo's Sensitive Data policy, tests are treated as public artifacts).

const DOCS = {
  'SOUL.md': [
    '# Soul Document — Ada Lumen',
    '## Identity',
    '- **Name:** Ada Lumen',
    '- **Aliases:** lum | lumenaut',
    '- **Orientation:** Rationalist, tinkerer',
    '- **Primary Mode:** Builder, planner, tinkerer',
    '## Core Purpose',
    'Life is organized around building useful tools and durable artifacts.',
    '## Communication Preferences',
    '- No filler',
    '- Clarity over comfort',
    'Tone target:',
    '> Peer collaborator with sharp edges',
    '## Humor',
    '- dry',
    '- absurd',
    '## References',
    '- Example',
  ].join('\n'),
  'COMMUNICATION.md': [
    '# Communication Style',
    '### How do you prefer to receive critical feedback?',
    'direct',
  ].join('\n'),
  'PERSONALITY.md': [
    '# Personality Assessments',
    '### What is your Myers-Briggs type?',
    'INTP/ENTP',
  ].join('\n'),
  'COGNITIVE.md': [
    '# Cognitive Architecture',
    '## Reasoning Defaults',
    '- Decompose then test',
    '- Systems thinking',
    '## Epistemic Style',
    '- Demands mechanism',
  ].join('\n'),
  'TECHNICAL.md': [
    '# Technical Profile',
    '## Depth & Orientation',
    '- Senior engineer across web stacks',
    '- Thinks in systems',
    '## Building Philosophy',
    '- Tool-builder by default',
  ].join('\n'),
  'CREATIVE.md': [
    '# Creative Profile',
    '## Creative DNA',
    '- Genre gravity: sci-fi + puzzles',
    '- Worlds over vignettes',
  ].join('\n'),
  'VALUES.md': [
    '# Values',
    '### What are the top three values that guide your most important decisions?',
    'curiosity, craft, candor',
  ].join('\n'),
  'NON_NEGOTIABLES.md': [
    '# Non-Negotiables',
    '### What topic should your digital twin absolutely refuse to engage with?',
    'medical diagnosis',
  ].join('\n'),
};

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (path) => {
    const name = String(path).split('/').pop();
    if (DOCS[name] != null) return DOCS[name];
    throw new Error('ENOENT');
  }),
}));

vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));

vi.mock('./digital-twin-helpers.js', () => ({
  DIGITAL_TWIN_DIR: '/twin',
  callProviderAI: vi.fn(),
}));

vi.mock('./digital-twin-meta.js', () => ({ loadMeta: vi.fn() }));
vi.mock('./digital-twin-analysis.js', () => ({ getTraits: vi.fn() }));
vi.mock('./identity.js', () => ({ getGoals: vi.fn() }));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));

import { buildAvatarBio, polishAvatarBio } from './digital-twin-avatar-bio.js';
import { loadMeta } from './digital-twin-meta.js';
import { getTraits } from './digital-twin-analysis.js';
import { getGoals } from './identity.js';
import { getProviderById } from './providers.js';
import { callProviderAI } from './digital-twin-helpers.js';

beforeEach(() => {
  vi.clearAllMocks();
  loadMeta.mockResolvedValue({ documents: [] }); // nothing explicitly disabled
  getTraits.mockResolvedValue(null);
  getGoals.mockResolvedValue({
    goals: [
      { title: 'Build a Useful Tool', status: 'active', priority: 'high' },
      { title: 'Learn the Cello', status: 'active', priority: 'low' },
      { title: 'Old Finished Thing', status: 'completed', priority: 'low' },
    ],
  });
});

describe('buildAvatarBio', () => {
  it('assembles three grounded sections from twin documents', async () => {
    const bio = await buildAvatarBio();

    expect(bio.name).toBe('Ada Lumen');
    expect(bio.length).toBe('persona');
    expect(bio.combined).toContain('## Who I Am');
    expect(bio.combined).toContain('## How I Speak');
    expect(bio.combined).toContain('## What I Know');

    // WHO — identity + values + goals (completed goal excluded)
    expect(bio.sections.whoIAm).toContain('Ada Lumen');
    expect(bio.sections.whoIAm).toContain('curiosity, craft, candor');
    expect(bio.sections.whoIAm).toContain('Build a Useful Tool');
    expect(bio.sections.whoIAm).not.toContain('Old Finished Thing');

    // HOW — tone target + MBTI + feedback pref
    expect(bio.sections.howISpeak).toContain('Peer collaborator with sharp edges');
    expect(bio.sections.howISpeak).toContain('INTP/ENTP');
    expect(bio.sections.howISpeak.toLowerCase()).toContain('direct');

    // WHAT — technical + creative + reasoning
    expect(bio.sections.whatIKnow).toContain('Senior engineer');
    expect(bio.sections.whatIKnow.toLowerCase()).toContain('sci-fi');

    expect(bio.tokenEstimate).toBeGreaterThan(0);
  });

  it('flags hasVoiceTraits false when no communication profile is stored', async () => {
    const bio = await buildAvatarBio();
    expect(bio.hasVoiceTraits).toBe(false);
    expect(bio.sections.howISpeak).not.toContain('Cadence:');
  });

  it('includes numeric cadence + markers when traits are present', async () => {
    getTraits.mockResolvedValue({
      communicationProfile: {
        formality: 4, verbosity: 7, avgSentenceLength: 18,
        distinctiveMarkers: ['em-dashes', 'first-principles framing'],
      },
    });
    const bio = await buildAvatarBio();
    expect(bio.hasVoiceTraits).toBe(true);
    expect(bio.sections.howISpeak).toContain('Cadence:');
    expect(bio.sections.howISpeak).toContain('4/10');
    expect(bio.sections.howISpeak).toContain('em-dashes');
  });

  it('blurb length omits refuse-topic and humor detail', async () => {
    const bio = await buildAvatarBio({ length: 'blurb' });
    expect(bio.length).toBe('blurb');
    expect(bio.sections.whoIAm).not.toContain('Will not engage with');
    expect(bio.sections.howISpeak).not.toContain('Humor:');
  });

  it('excludes documents the user has disabled in meta', async () => {
    // SOUL.md disabled → identity/tone/values-from-soul must not surface, and the
    // name falls back rather than leaking the disabled doc's content.
    loadMeta.mockResolvedValue({
      documents: [{ filename: 'SOUL.md', enabled: false }],
    });
    const bio = await buildAvatarBio();
    expect(bio.name).toBe('the user');
    expect(bio.sections.whoIAm).not.toContain('Ada Lumen');
    expect(bio.sections.howISpeak).not.toContain('Peer collaborator with sharp edges');
    // A still-enabled doc (COMMUNICATION.md) is unaffected.
    expect(bio.sections.howISpeak.toLowerCase()).toContain('direct');
  });

  it('falls back gracefully when documents are missing', async () => {
    const fsp = await import('fs/promises');
    fsp.readFile.mockRejectedValue(new Error('ENOENT'));
    getGoals.mockResolvedValue({ goals: [] });
    const bio = await buildAvatarBio();
    expect(bio.name).toBe('the user');
    expect(bio.sections.whoIAm).toContain('No identity data yet');
    expect(bio.sections.howISpeak).toContain('No communication data yet');
  });
});

describe('polishAvatarBio', () => {
  it('rejects when the provider is missing or disabled', async () => {
    getProviderById.mockResolvedValue(null);
    const res = await polishAvatarBio({ providerId: 'x', model: 'm' });
    expect(res.error).toMatch(/provider not found/i);
    expect(callProviderAI).not.toHaveBeenCalled();
  });

  it('returns refined content on a well-formed provider response', async () => {
    getProviderById.mockResolvedValue({ id: 'x', enabled: true });
    callProviderAI.mockResolvedValue({
      text: '## Who I Am\nI am Ada.\n## How I Speak\nDirectly.\n## What I Know\nSystems.',
    });
    const res = await polishAvatarBio({ providerId: 'x', model: 'm' });
    expect(res.error).toBeUndefined();
    expect(res.content).toContain('Who I Am');
    expect(res.tokenEstimate).toBeGreaterThan(0);
  });

  it('surfaces an unparseable response instead of passing it off as a bio', async () => {
    getProviderById.mockResolvedValue({ id: 'x', enabled: true });
    callProviderAI.mockResolvedValue({ text: 'Sorry, I cannot help with that.' });
    const res = await polishAvatarBio({ providerId: 'x', model: 'm' });
    expect(res.error).toMatch(/could not be parsed/i);
    expect(res.rawResponse).toBeTruthy();
  });
});

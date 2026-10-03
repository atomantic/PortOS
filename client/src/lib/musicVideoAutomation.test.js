import { describe, it, expect } from 'vitest';
import { automationDraftFrom, automationFromDraft, llmRouteLabel } from './musicVideoAutomation.js';
import { autonomousRequestFromDraft, autopilotDraftFromParams, autopilotParamsFromDraft, emptyAutonomousDraft } from './musicVideoAutonomous.js';

describe('brief draft ↔ wire mapping for the direction LLM (#9545)', () => {
  it('round-trips a saved pin, and leaves Auto (and a pre-pin record) out of the payload', () => {
    const saved = { tools: ['image:local'], guidance: 'g', budgetUsd: null, llm: { providerId: 'claude-tui', model: 'opus', effort: 'high' } };
    const draft = automationDraftFrom(saved);
    expect(draft.llm).toEqual({ providerId: 'claude-tui', model: 'opus', effort: 'high' });
    expect(automationFromDraft(draft).llm).toEqual({ providerId: 'claude-tui', model: 'opus', effort: 'high' });

    // Blank model/effort become null so the server stores "provider default / no effort".
    expect(automationFromDraft({ ...draft, llm: { providerId: 'claude-tui', model: '', effort: '' } }).llm)
      .toEqual({ providerId: 'claude-tui', model: null, effort: null });

    const auto = automationDraftFrom({ tools: [], guidance: '', budgetUsd: null });
    expect(auto.llm).toEqual({ providerId: '', model: '', effort: '' });
    expect('llm' in automationFromDraft(auto)).toBe(false);
  });

  it('names a route on one line', () => {
    expect(llmRouteLabel({ providerId: 'claude-tui', model: 'opus', effort: 'high', transport: 'tui' })).toBe('claude-tui · opus · high (TUI)');
    expect(llmRouteLabel({ providerId: 'cloud', transport: 'api' })).toBe('cloud (API)');
  });
});

describe('autonomous entry and scheduled params carry effort (#9545)', () => {
  it('sends effort only with a provider, and stores it on the scheduled pin', () => {
    const draft = emptyAutonomousDraft();
    expect(autonomousRequestFromDraft({ ...draft, prompt: 'p' }, { providerId: 'claude-tui', model: 'opus', effort: 'high' }))
      .toMatchObject({ providerId: 'claude-tui', model: 'opus', effort: 'high' });
    expect(autonomousRequestFromDraft({ ...draft, prompt: 'p' }, { effort: 'high' })).not.toHaveProperty('effort');

    expect(autopilotParamsFromDraft(draft, null, { providerId: 'claude-tui', model: 'opus', effort: 'low' }).llm)
      .toEqual({ providerId: 'claude-tui', model: 'opus', effort: 'low' });
    expect(autopilotParamsFromDraft(draft, null, { providerId: 'claude-tui' }).llm).toEqual({ providerId: 'claude-tui', model: null });
  });
});

describe('per-stage LLM pins in the draft ↔ wire mapping', () => {
  const plan = { providerId: 'claude-tui', model: 'opus', effort: 'high' };

  it('round-trips a stage pin, clears a saved stage set back to Default with null, and sends nothing when no stage is pinned', () => {
    const saved = { tools: [], guidance: '', budgetUsd: null, llmStages: { plan, castAndSets: { providerId: 'cloud', model: null, effort: null } } };
    const draft = automationDraftFrom(saved);
    expect(draft.llmStages.plan).toEqual({ providerId: 'claude-tui', model: 'opus', effort: 'high' });
    expect(automationFromDraft(draft, saved).llmStages).toEqual(saved.llmStages);

    const { castAndSets: _cleared, ...kept } = draft.llmStages;
    expect(automationFromDraft({ ...draft, llmStages: kept }, saved).llmStages).toEqual({ plan, castAndSets: null });
    expect('llmStages' in automationFromDraft(automationDraftFrom({ tools: [], guidance: '', budgetUsd: null }))).toBe(false);
  });

  it('carries stage pins and the lyric review toggle on a start request and the scheduled params', () => {
    const draft = { ...emptyAutonomousDraft(), prompt: 'p', llmStages: { lyricsReview: { providerId: 'cloud', model: '', effort: '' } }, lyricsReview: true };
    expect(autonomousRequestFromDraft(draft)).toMatchObject({ llmStages: { lyricsReview: { providerId: 'cloud', model: null, effort: null } }, lyricsReview: true });
    expect(autonomousRequestFromDraft({ ...emptyAutonomousDraft(), prompt: 'p' })).not.toHaveProperty('llmStages');

    const params = autopilotParamsFromDraft(draft, null);
    expect(params).toMatchObject({ llmStages: { lyricsReview: { providerId: 'cloud' } }, lyricsReview: true });
    expect(autopilotDraftFromParams(params)).toMatchObject({ llmStages: { lyricsReview: { providerId: 'cloud', model: '', effort: '' } }, lyricsReview: true });
    // Params are replaced whole, so clearing every stage saves an explicit null.
    expect(autopilotParamsFromDraft({ ...draft, llmStages: {}, lyricsReview: false }, params)).toMatchObject({ llmStages: null, lyricsReview: false });
  });
});

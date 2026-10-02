import { describe, it, expect } from 'vitest';
import { automationDraftFrom, automationFromDraft, llmRouteLabel } from './musicVideoAutomation.js';
import { autonomousRequestFromDraft, autopilotParamsFromDraft, emptyAutonomousDraft } from './musicVideoAutonomous.js';

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

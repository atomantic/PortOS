import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  updatePostConfig: vi.fn(),
  getProviders: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import PostDrillConfig from './PostDrillConfig';
import { updatePostConfig, getProviders } from '../../../services/api';

// The 14 generatable LLM drill types (mirror server + client constants).
const ALL_LLM_TYPES = [
  'pun-wordplay', 'word-association', 'compound-chain', 'bridge-word',
  'double-meaning', 'idiom-twist', 'story-recall', 'verbal-fluency',
  'wit-comeback', 'what-if', 'alternative-uses', 'story-prompt',
  'invention-pitch', 'reframe',
];
const LABELS = {
  'pun-wordplay': 'Pun & Wordplay', 'word-association': 'Word Association',
  'compound-chain': 'Compound Chain', 'bridge-word': 'Bridge Word',
  'double-meaning': 'Double Meaning', 'idiom-twist': 'Idiom Twist',
  'story-recall': 'Story Recall', 'verbal-fluency': 'Verbal Fluency',
  'wit-comeback': 'Wit & Comeback', 'what-if': 'What If?',
  'alternative-uses': 'Alternative Uses', 'story-prompt': 'Story Prompt',
  'invention-pitch': 'Invention Pitch', 'reframe': 'Reframe',
};

// Mirrors the server DEFAULT_CONFIG: only the 5 legacy LLM drills ship enabled.
const config = {
  mentalMath: { drillTypes: { 'multiplication': { enabled: true, count: 10 } } },
  llmDrills: {
    enabled: true,
    providerId: null,
    model: null,
    drillTypes: {
      'word-association': { enabled: true, count: 5, timeLimitSec: 120 },
      'story-recall': { enabled: true, count: 3, timeLimitSec: 180 },
      'verbal-fluency': { enabled: true, count: 3, timeLimitSec: 60 },
      'wit-comeback': { enabled: true, count: 5, timeLimitSec: 120 },
      'pun-wordplay': { enabled: true, count: 5, timeLimitSec: 120 },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getProviders.mockResolvedValue({ providers: [] });
  updatePostConfig.mockResolvedValue(config);
});

describe('PostDrillConfig', () => {
  it('renders a card for every one of the 14 LLM drill types', () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    for (const type of ALL_LLM_TYPES) {
      expect(screen.getByText(LABELS[type])).toBeTruthy();
    }
  });

  it('groups LLM drills under Wordplay / Verbal Agility / Imagination headers', () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('Wordplay')).toBeTruthy();
    expect(screen.getByText('Verbal Agility')).toBeTruthy();
    expect(screen.getByText('Imagination')).toBeTruthy();
  });

  it('persists all 14 LLM drill types on save, with the 9 newly-exposed drills defaulting off', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());

    const payload = updatePostConfig.mock.calls[0][0];
    const saved = payload.llmDrills.drillTypes;
    // Every type is persisted so the config never silently omits a card the user saw.
    expect(Object.keys(saved).sort()).toEqual([...ALL_LLM_TYPES].sort());
    // The 5 legacy drills stay enabled...
    for (const t of ['pun-wordplay', 'word-association', 'story-recall', 'verbal-fluency', 'wit-comeback']) {
      expect(saved[t].enabled).toBe(true);
    }
    // ...and the 9 newly-exposed drills default to disabled (opt-in).
    for (const t of ['compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist',
      'what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe']) {
      expect(saved[t].enabled).toBe(false);
    }
  });

  it('enabling a newly-exposed drill persists it as enabled', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    // Toggle the "What If?" card (a previously-inaccessible imagination drill) on.
    fireEvent.click(screen.getByRole('switch', { name: 'What If?' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());

    const saved = updatePostConfig.mock.calls[0][0].llmDrills.drillTypes;
    expect(saved['what-if'].enabled).toBe(true);
    // A sibling imagination drill left untouched stays disabled.
    expect(saved['reframe'].enabled).toBe(false);
  });

  it('preserves a saved new-type entry that is active by presence (no enabled field)', async () => {
    // A config where a newly-exposed drill is present but omits `enabled` —
    // the launcher treats this as active (enabled !== false). Seeding must not
    // silently disable it via the opt-in default.
    const withPresentNewType = {
      ...config,
      llmDrills: {
        ...config.llmDrills,
        drillTypes: { ...config.llmDrills.drillTypes, 'what-if': { count: 3 } },
      },
    };
    render(<PostDrillConfig config={withPresentNewType} onSaved={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'What If?' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    expect(updatePostConfig.mock.calls[0][0].llmDrills.drillTypes['what-if'].enabled).toBe(true);
  });

  it('exposes toggles as accessible switches reflecting on/off state', () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    // Legacy enabled drill → switch checked; newly-exposed drill → unchecked.
    expect(screen.getByRole('switch', { name: 'Pun & Wordplay' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Reframe' }).getAttribute('aria-checked')).toBe('false');
  });
});

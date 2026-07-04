import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  updatePostConfig: vi.fn(),
  getProviders: vi.fn(),
  getPostAdaptivePreview: vi.fn(),
  getPostMultiplicationProgress: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import PostDrillConfig from './PostDrillConfig';
import { updatePostConfig, getProviders, getPostAdaptivePreview, getPostMultiplicationProgress } from '../../../services/api';

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
  getPostAdaptivePreview.mockResolvedValue({ enabled: false, drills: {} });
  getPostMultiplicationProgress.mockResolvedValue({
    level: 0,
    label: '1×1-digit',
    atHardest: false,
    currentMastered: false,
    levels: [
      { level: 0, label: '1×1-digit', mastered: false },
      { level: 1, label: '1×2-digit', mastered: false },
    ],
    thresholds: { minSamples: 12, targetAccuracy: 0.9 },
    windowDays: 30,
  });
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

  it('defaults the Adaptive difficulty toggle to off and persists it on save', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: 'Adaptive difficulty' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    expect(updatePostConfig.mock.calls[0][0].adaptive).toEqual({ enabled: false });
  });

  it('reflects a saved adaptive.enabled=true, fetches the preview, and shows effective difficulty', async () => {
    getPostAdaptivePreview.mockResolvedValue({
      enabled: true,
      drills: {
        multiplication: { type: 'multiplication', field: 'maxDigits', from: 2, to: 3, applied: true, score: 94, samples: 5, reason: 'harder' },
      },
    });
    // Multiplication defaults to the progressive ladder (which supersedes the
    // adaptive badge on that card); turn it off here so the adaptive preview is
    // what renders for this test.
    const withAdaptive = {
      ...config,
      mentalMath: { drillTypes: { multiplication: { enabled: true, count: 10, progressive: false } } },
      adaptive: { enabled: true },
    };
    render(<PostDrillConfig config={withAdaptive} onSaved={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Adaptive difficulty' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(getPostAdaptivePreview).toHaveBeenCalled());
    // The enabled multiplication card surfaces the effective (adapted) difficulty.
    await waitFor(() => expect(screen.getByText(/max digits 2 → 3 \(harder\)/)).toBeTruthy());
  });

  it('labels the estimation hardest boundary by difficulty, not numeric max', async () => {
    // For estimation, lower tolerance is harder — so the hardest boundary carries
    // the MINIMUM tolerance value. The badge must read "hardest", never "at max".
    getPostAdaptivePreview.mockResolvedValue({
      enabled: true,
      drills: {
        estimation: { type: 'estimation', field: 'tolerancePct', from: 3, to: 3, applied: false, score: 96, samples: 6, reason: 'at-hardest' },
      },
    });
    const withAdaptive = {
      ...config,
      mentalMath: { drillTypes: { ...config.mentalMath.drillTypes, estimation: { enabled: true, tolerancePct: 3 } } },
      adaptive: { enabled: true },
    };
    render(<PostDrillConfig config={withAdaptive} onSaved={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(getPostAdaptivePreview).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/hardest tolerance % 3/)).toBeTruthy());
    expect(screen.queryByText(/at max tolerance/)).toBeNull();
  });

  it('multiplication defaults to Progressive difficulty on, hiding Max Digits and showing the ladder', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: 'Progressive difficulty' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    // Max Digits is ignored while progressive is on, so its field is hidden.
    expect(screen.queryByText('Max Digits')).toBeNull();
    // The fetched ladder status renders.
    await waitFor(() => expect(getPostMultiplicationProgress).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Level 1 of 2 · 1×1-digit/)).toBeTruthy());
  });

  it('toggling Progressive off reveals Max Digits and persists progressive=false', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Progressive difficulty' }));
    expect(screen.getByText('Max Digits')).toBeTruthy();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    expect(updatePostConfig.mock.calls[0][0].mentalMath.drillTypes.multiplication.progressive).toBe(false);
  });

  it('toggling Adaptive on persists enabled=true', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Adaptive difficulty' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    expect(updatePostConfig.mock.calls[0][0].adaptive).toEqual({ enabled: true });
  });

  it('defaults the Daily Reminder toggle to off, hides the time picker, and persists off on save', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: 'Daily reminder' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByLabelText('Remind me at')).toBeNull();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    expect(updatePostConfig.mock.calls[0][0].reminder).toEqual({ enabled: false, time: '09:00' });
  });

  it('enabling the Daily Reminder reveals the time picker and persists the chosen time', async () => {
    render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Daily reminder' }));
    const timeInput = screen.getByLabelText('Remind me at');
    fireEvent.change(timeInput, { target: { value: '18:30' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    expect(updatePostConfig.mock.calls[0][0].reminder).toEqual({ enabled: true, time: '18:30' });
  });

  it('reflects a saved reminder.enabled=true with its stored time', () => {
    const withReminder = { ...config, reminder: { enabled: true, time: '20:15' } };
    render(<PostDrillConfig config={withReminder} onSaved={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Daily reminder' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('Remind me at').value).toBe('20:15');
  });

  describe('presets', () => {
    it('"Balanced daily" enables 2 math + 2 cognitive drills, turns cognitive on, and turns LLM off', async () => {
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      fireEvent.click(screen.getByText('Balanced daily'));
      expect(screen.getByRole('switch', { name: 'Multiplication' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Estimation' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Doubling Chain' }).getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('switch', { name: 'N-Back' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Stroop' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Digit Span' }).getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('switch', { name: 'Cognitive drills' }).getAttribute('aria-checked')).toBe('true');
      // LLM section collapses once its domain toggle is switched off by the preset.
      expect(screen.getByRole('switch', { name: 'Wit & Memory (LLM) drills' }).getAttribute('aria-checked')).toBe('false');
      expect(screen.queryByText('AI Provider')).toBeNull();

      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
      const payload = updatePostConfig.mock.calls[0][0];
      expect(payload.mentalMath.drillTypes.multiplication.enabled).toBe(true);
      expect(payload.mentalMath.drillTypes.estimation.enabled).toBe(true);
      expect(payload.mentalMath.drillTypes['doubling-chain'].enabled).toBe(false);
      expect(payload.cognitive.enabled).toBe(true);
      expect(payload.cognitive.drillTypes['n-back'].enabled).toBe(true);
      expect(payload.cognitive.drillTypes['stroop'].enabled).toBe(true);
      expect(payload.cognitive.drillTypes['digit-span'].enabled).toBe(false);
      expect(payload.llmDrills.enabled).toBe(false);
    });

    it('"Math focus" enables every math drill and turns cognitive + LLM off', () => {
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      fireEvent.click(screen.getByText('Math focus'));
      for (const label of ['Doubling Chain', 'Serial Subtraction', 'Multiplication', 'Powers', 'Estimation']) {
        expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true');
      }
      expect(screen.getByRole('switch', { name: 'Cognitive drills' }).getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('switch', { name: 'Wit & Memory (LLM) drills' }).getAttribute('aria-checked')).toBe('false');
    });

    it('"Cognitive focus" disables all math drills and enables every cognitive drill', () => {
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      fireEvent.click(screen.getByText('Cognitive focus'));
      expect(screen.getByRole('switch', { name: 'Multiplication' }).getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('switch', { name: 'Cognitive drills' }).getAttribute('aria-checked')).toBe('true');
      for (const label of ['N-Back', 'Digit Span', 'Stroop', 'Schulte Table', 'Mental Rotation', 'Reaction Time']) {
        expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true');
      }
      expect(screen.getByRole('switch', { name: 'Wit & Memory (LLM) drills' }).getAttribute('aria-checked')).toBe('false');
    });

    it('"Everything (local-only)" enables every math + cognitive drill but never LLM', () => {
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      fireEvent.click(screen.getByText('Everything (local-only)'));
      expect(screen.getByRole('switch', { name: 'Powers' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Mental Rotation' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Cognitive drills' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('switch', { name: 'Wit & Memory (LLM) drills' }).getAttribute('aria-checked')).toBe('false');
    });
  });

  describe('per-group enable/disable-all', () => {
    it('Mental Math "Enable all" / "Disable all" toggle every math drill', () => {
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Enable all Mental Math drills'));
      for (const label of ['Doubling Chain', 'Serial Subtraction', 'Multiplication', 'Powers', 'Estimation']) {
        expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true');
      }
      fireEvent.click(screen.getByLabelText('Disable all Mental Math drills'));
      for (const label of ['Doubling Chain', 'Serial Subtraction', 'Multiplication', 'Powers', 'Estimation']) {
        expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('false');
      }
    });

    it('Cognitive "Enable all" / "Disable all" toggle every cognitive drill', () => {
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Enable all Cognitive drills'));
      expect(screen.getByRole('switch', { name: 'Digit Span' }).getAttribute('aria-checked')).toBe('true');
      fireEvent.click(screen.getByLabelText('Disable all Cognitive drills'));
      expect(screen.getByRole('switch', { name: 'Digit Span' }).getAttribute('aria-checked')).toBe('false');
    });

    it('LLM "Enable all" is blocked without a chosen provider — no toggles flip, an error toast fires', async () => {
      const toastModule = await import('../../ui/Toast');
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Enable all LLM drills'));
      // Untouched drills stay at their config-seeded (opt-in-disabled) state.
      expect(screen.getByRole('switch', { name: 'Reframe' }).getAttribute('aria-checked')).toBe('false');
      expect(toastModule.default.error).toHaveBeenCalled();
    });

    it('LLM "Enable all" enables every LLM drill once a provider is chosen', async () => {
      getProviders.mockResolvedValue({
        providers: [{ id: 'prov-1', name: 'Test Provider', type: 'api', enabled: true, models: [] }],
      });
      render(<PostDrillConfig config={config} onSaved={vi.fn()} onBack={vi.fn()} />);
      await waitFor(() => expect(getProviders).toHaveBeenCalled());
      const providerSelect = screen.getByLabelText('Provider');
      await waitFor(() => expect(providerSelect.querySelectorAll('option')).toHaveLength(2));
      fireEvent.change(providerSelect, { target: { value: 'prov-1' } });
      fireEvent.click(screen.getByLabelText('Enable all LLM drills'));
      expect(screen.getByRole('switch', { name: 'Reframe' }).getAttribute('aria-checked')).toBe('true');
      fireEvent.click(screen.getByLabelText('Disable all LLM drills'));
      expect(screen.getByRole('switch', { name: 'Reframe' }).getAttribute('aria-checked')).toBe('false');
    });
  });
});

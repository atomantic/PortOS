import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the API surface the launcher touches on mount (providers + review reps +
// recommendations) so the render tests are deterministic and offline.
vi.mock('../../../services/api', () => ({
  getProviders: vi.fn().mockResolvedValue([]),
  getPostReviewReps: vi.fn().mockResolvedValue({ reps: [] }),
  getPostRecommendations: vi.fn().mockResolvedValue({ recommendations: [] }),
  getMorseProgress: vi.fn().mockResolvedValue({ settings: { wpm: 18, farnsworthWpm: 12 } }),
  getPostProgress: vi.fn().mockResolvedValue({ series: { byDay: [] } }),
}));

import PostSessionLauncher, { buildCleanTags, cognitiveSummary, interleaveByDomain } from './PostSessionLauncher';
import { getPostRecommendations, getMorseProgress, getPostProgress, getPostReviewReps } from '../../../services/api';

// Pure-function tests for PostSessionLauncher's pre-submit helpers (issue
// #2102 gap #10). Both were lifted from component-body closures to module
// scope with explicit parameters (`tags` for buildCleanTags) so they can be
// tested directly without rendering the launcher or its provider fetch.

describe('buildCleanTags', () => {
  it('keeps a filled-in value, trimmed', () => {
    expect(buildCleanTags({ sleep: '  good  ', caffeine: '', stress: '' })).toEqual({ sleep: 'good' });
  });

  it('drops empty-string values', () => {
    expect(buildCleanTags({ sleep: '', caffeine: '', stress: '' })).toEqual({});
  });

  it('drops whitespace-only values', () => {
    expect(buildCleanTags({ sleep: '   ', caffeine: '\t', stress: '' })).toEqual({});
  });

  it('keeps multiple filled-in values, each trimmed independently', () => {
    expect(buildCleanTags({ sleep: 'poor', caffeine: ' 2 cups ', stress: 'high' })).toEqual({
      sleep: 'poor',
      caffeine: '2 cups',
      stress: 'high',
    });
  });

  it('returns an empty object for an empty tags map', () => {
    expect(buildCleanTags({})).toEqual({});
  });
});

describe('cognitiveSummary', () => {
  it('summarizes n-back as "<n>-back", defaulting n to 2', () => {
    expect(cognitiveSummary('n-back', {})).toBe('2-back');
    expect(cognitiveSummary('n-back', { n: 3 })).toBe('3-back');
  });

  it('summarizes digit-span as a start–max length range, defaulting to 3–8', () => {
    expect(cognitiveSummary('digit-span', {})).toBe('3–8');
    expect(cognitiveSummary('digit-span', { startLength: 4, maxLength: 9 })).toBe('4–9');
  });

  it('summarizes schulte-table as a size×size grid, defaulting to 5×5', () => {
    expect(cognitiveSummary('schulte-table', {})).toBe('5×5');
    expect(cognitiveSummary('schulte-table', { size: 6 })).toBe('6×6');
  });

  it('summarizes reaction-time as trial count + mode, defaulting to 15 trials (simple)', () => {
    expect(cognitiveSummary('reaction-time', {})).toBe('15 trials (simple)');
    expect(cognitiveSummary('reaction-time', { count: 20, mode: 'choice' })).toBe('20 trials (choice)');
  });

  it('falls back to "<count> trials" for an unrecognized type with a count', () => {
    expect(cognitiveSummary('stroop', { count: 10 })).toBe('10 trials');
  });

  it('falls back to an empty string for an unrecognized type with no count', () => {
    expect(cognitiveSummary('mental-rotation', {})).toBe('');
  });
});

describe('interleaveByDomain (issue #2100)', () => {
  it('round-robins one drill per domain in canonical order', () => {
    const drills = [
      { type: 'multiplication', domain: 'math' },
      { type: 'powers', domain: 'math' },
      { type: 'n-back', domain: 'cognitive' },
      { type: 'memory-sequence', domain: 'memory' },
    ];
    const out = interleaveByDomain(drills).map(d => d.type);
    // Round 0: math, cognitive, memory; round 1: math (the second math drill).
    expect(out).toEqual(['multiplication', 'n-back', 'memory-sequence', 'powers']);
  });

  it('preserves per-domain input order', () => {
    const drills = [
      { type: 'a', domain: 'math' },
      { type: 'b', domain: 'math' },
      { type: 'c', domain: 'math' },
    ];
    expect(interleaveByDomain(drills).map(d => d.type)).toEqual(['a', 'b', 'c']);
  });

  it('interleaves unranked domains after the canonical ones, deterministically', () => {
    const drills = [
      { type: 'mystery', domain: 'zzz' },
      { type: 'multiplication', domain: 'math' },
    ];
    expect(interleaveByDomain(drills).map(d => d.type)).toEqual(['multiplication', 'mystery']);
  });

  it('returns an empty array for empty input', () => {
    expect(interleaveByDomain([])).toEqual([]);
    expect(interleaveByDomain()).toEqual([]);
  });
});

describe('PostSessionLauncher render (issue #2100)', () => {
  const baseConfig = {
    mentalMath: { enabled: true, drillTypes: { multiplication: { enabled: true, count: 10, timeLimitSec: 120 } } },
    llmDrills: { enabled: false, drillTypes: {} },
    cognitive: { enabled: false, drillTypes: {} },
    goals: { streakTarget: 10 },
  };
  const stats = { sessionCount: 3, overall: 70, currentStreak: 4, longestStreak: 8, byDrill: { 'mental-math:multiplication': 70 } };

  const renderLauncher = (props = {}) => render(
    <MemoryRouter>
      <PostSessionLauncher
        config={baseConfig}
        recentSessions={[]}
        stats={stats}
        statsWeek={{ sessionCount: 2 }}
        onStart={vi.fn()}
        onViewHistory={vi.fn()}
        onViewConfig={vi.fn()}
        onViewMemory={vi.fn()}
        onViewMorse={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    getPostRecommendations.mockResolvedValue({ recommendations: [] });
    getPostReviewReps.mockResolvedValue({ reps: [] });
    getMorseProgress.mockResolvedValue({ settings: { wpm: 18, farnsworthWpm: 12 } });
    getPostProgress.mockResolvedValue({ series: { byDay: [] } });
  });

  it('renders the "Up next" panel with working deep links', async () => {
    getPostRecommendations.mockResolvedValue({ recommendations: [
      { id: 'memory-due:song', kind: 'memory-due', title: 'Review "Elements"', detail: 'Due', deepLink: '/post/memory', priority: 0 },
      { id: 'stalled:morse-copy', kind: 'stalled-progression', title: 'Morse: keep climbing', detail: 'Koch 6', deepLink: '/post/morse/copy', priority: 1 },
    ] });
    const { container } = renderLauncher();
    await waitFor(() => expect(screen.getByText('Up next')).toBeTruthy());
    expect(screen.getByText('Review "Elements"')).toBeTruthy();
    expect(container.querySelector('a[href="/post/memory"]')).toBeTruthy();
    expect(container.querySelector('a[href="/post/morse/copy"]')).toBeTruthy();
  });

  it('renders goal progress against a configured goal', async () => {
    renderLauncher();
    await waitFor(() => expect(screen.getByText('Goals')).toBeTruthy());
    // streakTarget 10 with a 4-day streak → "4/10 d".
    expect(screen.getByText(/4\/10/)).toBeTruthy();
  });

  it('starts exactly the recommended drill (not the whole domain) for a launcher-targeted rec', async () => {
    const onStart = vi.fn();
    // Enable multiple math drills so a domain-focus would over-queue.
    const multiMathConfig = {
      ...baseConfig,
      mentalMath: { enabled: true, drillTypes: {
        multiplication: { enabled: true, count: 10, timeLimitSec: 120 },
        powers: { enabled: true, count: 8, timeLimitSec: 90 },
        estimation: { enabled: true, count: 5, timeLimitSec: 120 },
      } },
    };
    getPostRecommendations.mockResolvedValue({ recommendations: [
      { id: 'weak-skill:mm', kind: 'weak-skill', title: 'Shore up Multiplication', detail: 'x', deepLink: '/post/launcher', drillType: 'multiplication', priority: 0 },
    ] });
    renderLauncher({ onStart, config: multiMathConfig });
    await waitFor(() => expect(screen.getByText('Shore up Multiplication')).toBeTruthy());
    // A launcher-targeted rec renders as a button (does the practice), not a link.
    const row = screen.getByText('Shore up Multiplication').closest('button');
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(onStart).toHaveBeenCalledTimes(1);
    const drills = onStart.mock.calls[0][0];
    // Only the recommended drill runs — powers/estimation are NOT queued.
    expect(drills.map(d => d.type)).toEqual(['multiplication']);
  });

  it('launches a review rep (with markers) for a skill-review recommendation', async () => {
    const onStart = vi.fn();
    getPostReviewReps.mockResolvedValue({ reps: [
      { skillId: 'multiplication:L1', label: 'Multiplication 1×2', type: 'multiplication', module: 'mental-math', config: { count: 5, level: 1, review: true, reviewSkillId: 'multiplication:L1' } },
    ] });
    getPostRecommendations.mockResolvedValue({ recommendations: [
      { id: 'skill-review:multiplication:L1', kind: 'skill-review', title: 'Re-verify Multiplication 1×2', detail: 'Maintenance rep due', deepLink: '/post/launcher', drillType: 'multiplication', priority: 0 },
    ] });
    renderLauncher({ onStart });
    await waitFor(() => expect(screen.getByText('Re-verify Multiplication 1×2')).toBeTruthy());
    fireEvent.click(screen.getByText('Re-verify Multiplication 1×2').closest('button'));
    expect(onStart).toHaveBeenCalledTimes(1);
    const drills = onStart.mock.calls[0][0];
    expect(drills).toHaveLength(1);
    expect(drills[0].isReview).toBe(true);
    expect(drills[0].config.reviewSkillId).toBe('multiplication:L1');
  });

  it('fetches a review rep on demand when it was not preloaded, without starting a normal session', async () => {
    const onStart = vi.fn();
    const rep = { skillId: 'cognitive:n-back:L0', label: 'n-back L0', type: 'n-back', module: 'cognitive', config: { level: 0, review: true, reviewSkillId: 'cognitive:n-back:L0' } };
    // First call (mount preload) returns nothing; the on-demand click fetch finds it.
    getPostReviewReps.mockResolvedValueOnce({ reps: [] }).mockResolvedValue({ reps: [rep] });
    getPostRecommendations.mockResolvedValue({ recommendations: [
      { id: 'skill-review:cognitive:n-back:L0', kind: 'skill-review', title: 'Re-verify n-back L0', deepLink: '/post/launcher', drillType: 'n-back', priority: 0 },
    ] });
    renderLauncher({ onStart });
    await waitFor(() => expect(screen.getByText('Re-verify n-back L0')).toBeTruthy());
    fireEvent.click(screen.getByText('Re-verify n-back L0').closest('button'));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onStart.mock.calls[0][0][0].config.reviewSkillId).toBe('cognitive:n-back:L0');
  });

  it('does not start any session when a skill-review rep cannot be found', async () => {
    const onStart = vi.fn();
    getPostReviewReps.mockResolvedValue({ reps: [] }); // never resolves to the rep
    getPostRecommendations.mockResolvedValue({ recommendations: [
      { id: 'skill-review:multiplication:L1', kind: 'skill-review', title: 'Re-verify Multiplication', deepLink: '/post/launcher', drillType: 'multiplication', priority: 0 },
    ] });
    renderLauncher({ onStart });
    await waitFor(() => expect(screen.getByText('Re-verify Multiplication')).toBeTruthy());
    fireEvent.click(screen.getByText('Re-verify Multiplication').closest('button'));
    // A missing rep must NOT fall back to a normal Full POST.
    await new Promise(r => setTimeout(r, 0));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('counts training-log time toward the daily-minutes goal', async () => {
    getPostProgress.mockResolvedValue({ series: { byDay: [{ date: new Date().toISOString().split('T')[0], minutes: 15 }] } });
    renderLauncher({ config: { ...baseConfig, goals: { dailyMinutes: 20 } } });
    await waitFor(() => expect(getPostProgress).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/15\/20/)).toBeTruthy());
  });

  it('renders a Morse WPM goal by fetching current Morse speed', async () => {
    renderLauncher({ config: { ...baseConfig, goals: { morseWpmTarget: 20 } } });
    await waitFor(() => expect(getMorseProgress).toHaveBeenCalled());
    // Effective WPM prefers Farnsworth (12) → "12/20".
    await waitFor(() => expect(screen.getByText(/12\/20/)).toBeTruthy());
  });

  it('hides the goals panel when no goals are set', async () => {
    renderLauncher({ config: { ...baseConfig, goals: {} } });
    await waitFor(() => expect(getPostRecommendations).toHaveBeenCalled());
    expect(screen.queryByText('Goals')).toBeNull();
  });

  it('disables the start buttons when Session Composition excludes every enabled drill', async () => {
    const onStart = vi.fn();
    renderLauncher({ onStart, config: { ...baseConfig, sessionModules: [] } });
    await waitFor(() => expect(getPostRecommendations).toHaveBeenCalled());
    // An explicit empty selection means "no composed sessions" — Full POST is
    // disabled (not silently including all drills), with an explanatory notice.
    expect(screen.getByText('Full POST').closest('button').disabled).toBe(true);
    expect(screen.getByText(/Session Composition excludes every enabled drill/i)).toBeTruthy();
    fireEvent.click(screen.getByText('Full POST'));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('excludes LLM drills from Full POST when sessionModules omits llm-drills', async () => {
    const onStart = vi.fn();
    renderLauncher({
      onStart,
      config: {
        ...baseConfig,
        sessionModules: ['mental-math', 'cognitive'],
        llmDrills: { enabled: true, drillTypes: { 'wit-comeback': { enabled: true, count: 3 } } },
      },
    });
    await waitFor(() => expect(getPostRecommendations).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Full POST'));
    expect(onStart).toHaveBeenCalledTimes(1);
    const drills = onStart.mock.calls[0][0];
    expect(drills.some(d => d.type === 'wit-comeback')).toBe(false);
    expect(drills.some(d => d.type === 'multiplication')).toBe(true);
  });
});

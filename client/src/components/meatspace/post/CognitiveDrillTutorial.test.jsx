import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import {
  getDrillTutorial,
  hasDrillTutorial,
  hasSeenDrillTutorial,
  buildNBackExample,
  demoFrameDelay,
  nBackDemoCaption,
  CognitiveDrillTutorialPreview,
  CONFIG_DEPENDENT_TUTORIAL_TYPES,
} from './CognitiveDrillTutorial';
import { COGNITIVE_DRILL_TYPES } from './constants';

// The how-to material, exercised with NO drill runner mounted — that is the
// point of the split: this module is help text, so nothing here needs a scoring
// path or a stimulus generator to assert. The one clock in play belongs to the
// n-back demo loop, which animates an explanation and records nothing.
//
// The tutorial assertions that DO mount a runner stay in
// PostCognitiveDrillRunner.test.jsx ('first-run tutorial gate' and 'n-back
// tutorial card'), because what they cover is the runner's own gated mount —
// and they double as the check that the card really is reachable across the
// new module boundary, not just re-declared on one side of it.

describe('getDrillTutorial', () => {
  it('interpolates the n-back lag into the copy (plural)', () => {
    const t = getDrillTutorial({ type: 'n-back', config: { n: 3 } });
    expect(t.goal).toContain('3 steps');
    expect(t.steps.join(' ')).toContain('3 steps');
  });

  it('uses the singular "step" for a 1-back', () => {
    const t = getDrillTutorial({ type: 'n-back', config: { n: 1 } });
    expect(t.goal).toContain('1 step ');
    expect(t.goal).not.toContain('1 steps');
  });

  it('gives reversed-recall copy for backward digit-span', () => {
    expect(getDrillTutorial({ type: 'digit-span', config: { direction: 'backward' } }).goal).toContain('reverse');
    expect(getDrillTutorial({ type: 'digit-span', config: { direction: 'forward' } }).goal).toContain('order');
  });

  it('gives choice-mode reaction-time copy that mentions the lit box', () => {
    const t = getDrillTutorial({ type: 'reaction-time', config: { mode: 'choice' } });
    expect(t.steps.join(' ')).toMatch(/box/i);
  });

  it('returns null for an unknown or missing drill type', () => {
    expect(getDrillTutorial({ type: 'not-a-drill' })).toBeNull();
    expect(getDrillTutorial(null)).toBeNull();
  });
});

// The n-back tutorial's worked example. "Matches the letter N back" is the
// sentence first-timers misread, so the card shows a concrete stream with the
// one match called out — this asserts the example is actually a valid n-back
// hit, not just decorative letters.
describe('buildNBackExample', () => {
  it('has exactly ONE match, at the example lag, on the final letter', () => {
    for (const n of [1, 2, 3, 4]) {
      const { sequence } = buildNBackExample(n);
      const hitIndexes = sequence.reduce((acc, letter, i) => (i >= n && letter === sequence[i - n] ? [...acc, i] : acc), []);
      expect(hitIndexes).toEqual([sequence.length - 1]);
    }
  });

  it('clamps a nonsense lag instead of producing a broken strip', () => {
    const { sequence, n } = buildNBackExample(0);
    expect(n).toBe(1);
    expect(sequence.at(-1)).toBe(sequence.at(-2));
  });

  it('is attached to the n-back tutorial only', () => {
    expect(getDrillTutorial({ type: 'n-back', config: { n: 2 } }).nBackExample).toBeTruthy();
    expect(getDrillTutorial({ type: 'stroop' }).nBackExample).toBeUndefined();
  });
});

// Property guard for CONFIG_DEPENDENT_TUTORIAL_TYPES (issue #4732): the preview
// waits for the ladder rung only for the types on that list, so a new
// config-dependent branch in `getDrillTutorial` that ISN'T listed would silently
// go back to describing the stored knobs. Probing the real function beats
// re-listing the types by hand — the test can't drift from the code it guards.
describe('CONFIG_DEPENDENT_TUTORIAL_TYPES', () => {
  // Every knob any cognitive ladder or drill config can move, at two distinct
  // values — if the copy reads ANY of them, one of these pairs shifts it.
  const CONFIG_A = { n: 1, direction: 'forward', mode: 'simple', startLength: 4, maxLength: 6, size: 4, incongruentPct: 10, optionCount: 3, stimulusMs: 2500, ruleCount: 2, switchRatePct: 10, noGoPct: 10, lureSimilarity: 'low', congruentPct: 10, flankerStrength: 1, count: 5 };
  const CONFIG_B = { n: 3, direction: 'backward', mode: 'choice', startLength: 6, maxLength: 9, size: 6, incongruentPct: 90, optionCount: 4, stimulusMs: 1600, ruleCount: 3, switchRatePct: 90, noGoPct: 90, lureSimilarity: 'high', congruentPct: 90, flankerStrength: 3, count: 20 };

  it('lists exactly the drill types whose how-to copy changes with config', () => {
    const varies = COGNITIVE_DRILL_TYPES.filter(type => hasDrillTutorial(type)
      && JSON.stringify(getDrillTutorial({ type, config: CONFIG_A }))
        !== JSON.stringify(getDrillTutorial({ type, config: CONFIG_B })));
    expect(varies.sort()).toEqual([...CONFIG_DEPENDENT_TUTORIAL_TYPES].sort());
  });
});

// Standalone how-to preview (issue #4732) — the way back to a tutorial card the
// one-shot first-run gate has already been spent on. The load-bearing property
// is that it renders the SAME body with NO runner behind it, so nothing is
// timed or scored while the user reads.
describe('CognitiveDrillTutorialPreview', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('renders the how-to card, including the n-back worked example, with no runner mounted', () => {
    render(<CognitiveDrillTutorialPreview type="n-back" drillConfig={{ n: 3, progressive: false }} onClose={vi.fn()} />);
    expect(screen.getByText(/catch when one repeats from 3 steps earlier/i)).toBeInTheDocument();
    // The worked example strip — the whole reason the card needs to stay reachable.
    const example = screen.getByRole('list', { name: /example letter stream/i });
    expect(within(example).getByText('Match!')).toBeInTheDocument();
    expect(within(example).getByText('3 steps back')).toBeInTheDocument();
    // No runner: the n-back stimulus button and the gate's Start button are both absent.
    expect(screen.queryByRole('button', { name: /^match$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start drill/i })).not.toBeInTheDocument();
  });

  it('does not consume the first-run gate for the type it previewed', () => {
    render(<CognitiveDrillTutorialPreview type="stroop" drillConfig={{}} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /got it/i })).toBeInTheDocument();
    expect(hasSeenDrillTutorial('stroop')).toBe(false);
  });

  it('closes on "Got it"', () => {
    const onClose = vi.fn();
    render(<CognitiveDrillTutorialPreview type="flanker" drillConfig={{}} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('waits for the ladder rung rather than showing the stored knobs first', () => {
    // Laddered + progressive (the default) + progress not loaded (`null` = not
    // fetched). Rendering the card now would state a lag that changes under the
    // reader a moment later.
    render(<CognitiveDrillTutorialPreview type="n-back" drillConfig={{ n: 1 }} cognitiveProgress={null} onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/resolving your current n-back difficulty/i);
    expect(screen.queryByText(/repeats from 1 step earlier/i)).toBeNull();
  });

  it('shows the card immediately once the rung has resolved', () => {
    render(<CognitiveDrillTutorialPreview
      type="n-back"
      drillConfig={{ n: 1 }}
      cognitiveProgress={{ 'n-back': { config: { n: 3 } } }}
      onClose={vi.fn()}
    />);
    expect(screen.getByText(/catch when one repeats from 3 steps earlier/i)).toBeInTheDocument();
  });

  it('falls back to the stored knobs when the rung fetch came back empty, rather than hanging', () => {
    // `{}` = fetched-or-failed. The card is the best available answer; waiting
    // forever on a rung that is never coming is not.
    render(<CognitiveDrillTutorialPreview type="n-back" drillConfig={{ n: 1 }} cognitiveProgress={{}} onClose={vi.fn()} />);
    expect(screen.getByText(/catch when one repeats from 1 step earlier/i)).toBeInTheDocument();
    expect(screen.queryByText(/resolving your current/i)).toBeNull();
  });

  it('opens a config-independent card straight away, with no rung to wait for', () => {
    // Flanker is laddered, but its copy never mentions a config value — making it
    // wait would be a spinner for nothing.
    render(<CognitiveDrillTutorialPreview type="flanker" drillConfig={{}} cognitiveProgress={null} onClose={vi.fn()} />);
    expect(screen.getByText(/report the center arrow/i)).toBeInTheDocument();
    expect(screen.queryByText(/resolving your current/i)).toBeNull();
  });

  it('renders nothing for no selection or a type with no tutorial', () => {
    const { container, rerender } = render(<CognitiveDrillTutorialPreview type={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CognitiveDrillTutorialPreview type="not-a-drill" onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reflects the drill config it is handed, so a re-read matches the configured difficulty', () => {
    const { rerender } = render(
      <CognitiveDrillTutorialPreview type="digit-span" drillConfig={{ direction: 'backward', progressive: false }} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/then type them in reverse/i)).toBeInTheDocument();
    rerender(
      <CognitiveDrillTutorialPreview type="digit-span" drillConfig={{ direction: 'forward', progressive: false }} onClose={vi.fn()} />,
    );
    expect(screen.queryByText(/then type them in reverse/i)).not.toBeInTheDocument();
    expect(screen.getByText(/then type them back in order/i)).toBeInTheDocument();
  });
});

// The animated worked example (the n-back demo). The rule a first-timer misreads
// is a TIMING rule — "press Match when this letter repeats the one N back" — and
// the stream is transient, so the two letters being compared are never on screen
// together during a real run. These assert the demo actually teaches that: the
// letters arrive one at a time, the N-back marker slides with them, and the
// simulated press fires on the hit frame and on no other frame.
describe('n-back demo', () => {
  const originalMatchMedia = window.matchMedia;
  let mediaQuery;

  const renderDemo = (n) => {
    const { sequence } = buildNBackExample(n);
    const result = render(
      <CognitiveDrillTutorialPreview type="n-back" drillConfig={{ n, progressive: false }} onClose={vi.fn()} />,
    );
    return { ...result, sequence, last: sequence.length - 1 };
  };
  const stage = () => screen.getByTestId('nback-demo-stage').textContent;
  const press = () => screen.getByTestId('nback-demo-press').textContent;
  // Advance by exactly what the component says the CURRENT frame lasts, so
  // retuning its pacing can never leave these green against a dead timeline.
  // One advance per frame: the demo arms the next timeout from the effect that
  // runs after React commits the current one, so a single large advance would
  // only ever move it on by one letter.
  const advanceFrom = (step, last) => act(() => { vi.advanceTimersByTime(demoFrameDelay(step, last)); });
  const setVisibility = (value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };
  const playToHit = (last) => { for (let step = -1; step < last; step += 1) advanceFrom(step, last); };

  beforeEach(() => {
    vi.useFakeTimers();
    mediaQuery = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    window.matchMedia = vi.fn(() => mediaQuery);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    // Unconditional: the hidden-tab case below mutates `visibilityState`, and a
    // failing assertion there would otherwise leave the whole file hidden.
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('plays the stream one letter at a time and fires the press only on the hit', () => {
    const { sequence, last } = renderDemo(2);

    expect(stage()).toMatch(/get ready/i);
    expect(press()).toBe('Match');

    // Every non-match frame shows its letter with the press button still dark —
    // "do nothing" is the answer on all of them.
    advanceFrom(-1, last);
    for (let i = 0; i < last; i += 1) {
      expect(stage()).toBe(sequence[i]);
      expect(press()).toBe('Match');
      advanceFrom(i, last);
    }

    // Final letter: the repeat. This is the one frame the press belongs on.
    expect(stage()).toBe(sequence[last]);
    expect(press()).toBe('Match — pressed!');
    expect(screen.getByText(/press Match now/i)).toBeInTheDocument();
  });

  it('loops back to the pre-roll so a reader who looked away still catches it', () => {
    const { last } = renderDemo(2);
    playToHit(last);
    expect(press()).toBe('Match — pressed!');
    advanceFrom(last, last);
    expect(stage()).toMatch(/get ready/i);
    expect(press()).toBe('Match');
  });

  it('parks on the hit frame after a few passes instead of animating forever', () => {
    // An open help card would otherwise re-render this subtree for as long as it
    // is mounted. Replay is the way back.
    const { sequence, last } = renderDemo(2);
    for (let pass = 0; pass < 3; pass += 1) {
      playToHit(last);
      advanceFrom(last, last);
    }
    expect(stage()).toBe(sequence[last]);
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /replay example/i }));
    expect(stage()).toMatch(/get ready/i);
    advanceFrom(-1, last);
    expect(stage()).toBe(sequence[0]);
  });

  it('stops scheduling frames while the tab is hidden', () => {
    // PortOS is routinely left open on a second tailnet machine; an unseen
    // animation must not keep re-rendering there.
    const { sequence, last } = renderDemo(2);
    advanceFrom(-1, last);
    expect(stage()).toBe(sequence[0]);

    setVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0);

    setVisibility('visible');
    advanceFrom(0, last);
    expect(stage()).toBe(sequence[1]);
  });

  it('never starts when the card mounts into an already-hidden tab', () => {
    // The subscription only fires on a CHANGE, so seeding `hidden` from the
    // current state is the only thing standing between a backgrounded tab and a
    // demo that animates until someone looks at it again.
    setVisibility('hidden');
    renderDemo(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('marks exactly one chip as the N-back comparison on every frame', () => {
    // The sliding window IS the lesson, so a frame with two markers (or none)
    // would point the reader at the wrong pair of letters.
    const { last } = renderDemo(3);
    for (let step = -1; step <= last; step += 1) {
      const strip = within(screen.getByRole('list', { name: /example letter stream/i }));
      expect(strip.getAllByText('3 steps back')).toHaveLength(1);
      advanceFrom(step, last);
    }
  });

  it('holds the frame while paused and resumes from it', () => {
    const { sequence, last } = renderDemo(2);
    advanceFrom(-1, last);
    advanceFrom(0, last);
    expect(stage()).toBe(sequence[1]);

    fireEvent.click(screen.getByRole('button', { name: /pause example/i }));
    for (let i = 0; i < 10; i += 1) advanceFrom(1, last);
    expect(stage()).toBe(sequence[1]);
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /play example/i }));
    advanceFrom(1, last);
    expect(stage()).toBe(sequence[2]);
  });

  it('stops scheduling frames once unmounted', () => {
    const { last, unmount } = renderDemo(2);
    advanceFrom(-1, last);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the finished example, and no clock at all, under prefers-reduced-motion', () => {
    mediaQuery.matches = true;
    const { sequence, last } = renderDemo(2);
    // The last frame is the one that explains the rule, so stillness costs the
    // reader nothing — and there is no play control to imply motion is coming.
    expect(stage()).toBe(sequence[last]);
    expect(press()).toBe('Match — pressed!');
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole('button', { name: /pause example|play example|replay example/i })).not.toBeInTheDocument();
  });
});

// The frame schedule, pinned as a shape rather than as three magic numbers: the
// pre-roll and the hit both have to differ from an ordinary letter, and the hit
// has to be the longest or the press is gone before it registers.
describe('demoFrameDelay', () => {
  it('gives the pre-roll and the hit their own, longer dwell', () => {
    const last = 4;
    const ordinary = demoFrameDelay(1, last);
    expect(demoFrameDelay(-1, last)).not.toBe(ordinary);
    expect(demoFrameDelay(last, last)).toBeGreaterThan(ordinary);
    expect(demoFrameDelay(last, last)).toBeGreaterThan(demoFrameDelay(-1, last));
  });
});

// The caption is the demo's running commentary. Asserting it directly keeps the
// two cases the rendered test can't reach — the warm-up letters and a non-match
// — pinned without driving the clock for each one.
describe('nBackDemoCaption', () => {
  // A 2-back stream whose last letter repeats the one two back: index 3 is the
  // hit, index 2 the non-match, indexes 0-1 the warm-up.
  const sequence = ['K', 'R', 'T', 'R'];

  it('says there is nothing to answer yet during the warm-up letters', () => {
    expect(nBackDemoCaption({ sequence, n: 2, step: 0 })).toMatch(/nothing is 2 back yet/i);
    expect(nBackDemoCaption({ sequence, n: 2, step: 1 })).toMatch(/nothing is 2 back yet/i);
  });

  it('names both compared letters on a non-match and tells the reader to do nothing', () => {
    const caption = nBackDemoCaption({ sequence, n: 2, step: 2 });
    expect(caption).toContain('T');
    expect(caption).toContain('K');
    expect(caption).toMatch(/do nothing/i);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import useVoiceTurnProgress, { formatTurnLatency } from './useVoiceTurnProgress';

function Probe({ stage }) {
  const progress = useVoiceTurnProgress(stage);
  return (
    <div>
      <span data-testid="active">{progress.activeStep || 'none'}</span>
      <span data-testid="stt-done">{String(progress.sttDone)}</span>
      <span data-testid="llm-done">{String(progress.llmDone)}</span>
      <span data-testid="latency">{progress.latencyLabel || 'none'}</span>
    </div>
  );
}

describe('useVoiceTurnProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-28T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks STT → LLM → TTS stages and records time-to-first-audio across a turn', () => {
    const { rerender } = render(<Probe stage="idle" />);
    expect(screen.getByTestId('active')).toHaveTextContent('none');
    expect(screen.getByTestId('latency')).toHaveTextContent('none');

    rerender(<Probe stage="listening" />);
    expect(screen.getByTestId('active')).toHaveTextContent('stt');

    rerender(<Probe stage="thinking" />);
    expect(screen.getByTestId('active')).toHaveTextContent('llm');
    expect(screen.getByTestId('stt-done')).toHaveTextContent('true');

    vi.advanceTimersByTime(420);
    rerender(<Probe stage="speaking" />);
    expect(screen.getByTestId('active')).toHaveTextContent('tts');
    expect(screen.getByTestId('stt-done')).toHaveTextContent('true');
    expect(screen.getByTestId('llm-done')).toHaveTextContent('true');
    expect(screen.getByTestId('latency')).toHaveTextContent('420ms');

    // Keeps the last turn latency visible once back on standby.
    rerender(<Probe stage="idle" />);
    expect(screen.getByTestId('active')).toHaveTextContent('none');
    expect(screen.getByTestId('latency')).toHaveTextContent('420ms');
  });

  it('formats sub-second and multi-second turn latencies cleanly', () => {
    expect(formatTurnLatency(null)).toBeNull();
    expect(formatTurnLatency(0)).toBeNull();
    expect(formatTurnLatency(380)).toBe('380ms');
    expect(formatTurnLatency(1450)).toBe('1.5s');
  });
});

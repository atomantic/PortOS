import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SlotstreamServerCard from './SlotstreamServerCard.jsx';

const renderCard = (status, props = {}) => {
  const handlers = {
    onRefresh: vi.fn(),
    onSaveLaunch: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onInstall: vi.fn(),
  };
  render(
    <SlotstreamServerCard status={status} loading={false} busy={false} actionInProgress={null} {...handlers} {...props} />,
  );
  return handlers;
};

describe('SlotstreamServerCard', () => {
  it('surfaces the memory plan instead of hiding it', () => {
    renderCard({
      installed: true,
      running: false,
      supported: true,
      cachedModels: ['qwen-moe'],
      memoryPlan: { targetGb: 22, expectedPeakGb: 22, expectedWarmDecodeToks: 8, auto: false },
    });
    expect(screen.getByText('Target').closest('p')).toHaveTextContent('22 GB');
    expect(screen.getByText('Expected peak').closest('p')).toHaveTextContent('22 GB');
    expect(screen.getByText('Warm decode').closest('p')).toHaveTextContent('~8 tok/s');
  });

  it('saves checkpoint, port, and memory-cap override', () => {
    const handlers = renderCard({
      installed: true,
      running: false,
      supported: true,
      port: 5564,
      cachedModels: ['qwen-moe'],
      memoryPlan: { targetGb: 32, expectedPeakGb: 32, expectedWarmDecodeToks: 12, auto: true },
    });
    fireEvent.change(screen.getByLabelText('Checkpoint'), { target: { value: 'qwen-moe' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5565' } });
    fireEvent.change(screen.getByLabelText('Memory cap (GB)'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: /Save configuration/ }));
    expect(handlers.onSaveLaunch).toHaveBeenCalledWith({ model: 'qwen-moe', port: 5565, memoryGb: 22 });
  });

  it('seeds the form from the saved launch line so a saved cap survives a reload', () => {
    // Without this the memory cap the user saved is invisible on the next
    // visit, and re-saving after any other edit drops it — `launchPayload`
    // omits an empty field.
    const handlers = renderCard({
      installed: true,
      running: false,
      supported: true,
      cachedModels: ['qwen-moe'],
      launch: { model: 'qwen-moe', port: 5565, memoryGb: 22 },
      memoryPlan: { targetGb: 22, expectedPeakGb: 22, expectedWarmDecodeToks: 8, auto: false },
    });
    expect(screen.getByLabelText('Memory cap (GB)')).toHaveValue(22);
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5566' } });
    fireEvent.click(screen.getByRole('button', { name: /Save configuration/ }));
    expect(handlers.onSaveLaunch).toHaveBeenCalledWith({ model: 'qwen-moe', port: 5566, memoryGb: 22 });
  });

  it('does not name a terminal command when the cache is empty', () => {
    renderCard({ installed: true, running: false, supported: true, cachedModels: [], cacheError: null });
    expect(screen.getByText(/never downloads weights/i)).toBeInTheDocument();
    expect(screen.queryByText(/in a terminal/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Save configuration/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Start Slotstream/ })).toBeNull();
  });

  it('disables the row copy on a non-Apple-Silicon host', () => {
    renderCard({ supported: false, unsupportedReason: 'Slotstream runs only on macOS with Apple Silicon.' });
    expect(screen.getByText(/macOS with Apple Silicon/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install Slotstream/ })).toBeNull();
  });
});

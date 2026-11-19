import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MeditationTab from './MeditationTab';

const contexts = [];
function audioNode() {
  return { frequency: { value: 0 }, gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(function () { return arguments[0]; }), start: vi.fn(), stop: vi.fn(), onended: null };
}
function MockAudioContext() {
  this.state = 'running';
  this.currentTime = 0;
  this.destination = {};
  this.nodes = [];
  this.createOscillator = () => { const node = audioNode(); this.nodes.push(node); return node; };
  this.createGain = () => { const node = audioNode(); this.nodes.push(node); return node; };
  this.close = vi.fn(() => { this.state = 'closed'; return Promise.resolve(); });
  contexts.push(this);
}

beforeEach(() => { vi.useFakeTimers(); contexts.length = 0; vi.stubGlobal('AudioContext', MockAudioContext); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('sound meditation safety', () => {
  it('starts only on request, schedules a 40 Hz modulation and a finite quiet session', () => {
    render(<MeditationTab />);
    expect(contexts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    const context = contexts[0];
    expect(context.nodes[0].frequency.value).toBe(200);
    expect(context.nodes[1].frequency.value).toBe(40);
    expect(context.nodes[0].stop).toHaveBeenCalledWith(300);
    const envelope = context.nodes[4].gain;
    expect(envelope.linearRampToValueAtTime).toHaveBeenNthCalledWith(1, 0.01, 1);
    expect(envelope.setValueAtTime).toHaveBeenLastCalledWith(0.01, 299.96);
    expect(envelope.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, 0, 300);
    context.currentTime = 300;
    act(() => context.nodes[0].onended());
    expect(context.close).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Session complete');
  });

  it('releases a suspended context when the wall-clock session expires', () => {
    render(<MeditationTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    const context = contexts[0];
    context.state = 'suspended';
    act(() => vi.advanceTimersByTime(300_000));
    expect(context.close).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Session complete');
  });

  it('ignores a cancelled start that rejects after a later session begins', async () => {
    let rejectResume;
    function SuspendedAudioContext() {
      MockAudioContext.call(this);
      this.state = 'suspended';
      this.resume = () => new Promise((_resolve, reject) => { rejectResume = reject; });
    }
    vi.stubGlobal('AudioContext', SuspendedAudioContext);
    render(<MeditationTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop sound' }));
    expect(contexts[0].close).toHaveBeenCalledOnce();
    vi.stubGlobal('AudioContext', MockAudioContext);
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    await act(async () => { rejectResume(new Error('cancelled')); });
    expect(screen.getByRole('status')).toHaveTextContent('Sound is playing');
    expect(contexts[1].close).not.toHaveBeenCalled();
  });

  it('fades to silence on Stop, Escape, backgrounding, pagehide and unmount', () => {
    const view = render(<MeditationTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop sound' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    hidden.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    fireEvent(window, new Event('pagehide'));
    fireEvent.click(screen.getByRole('button', { name: 'Start sound' }));
    view.unmount();
    expect(contexts).toHaveLength(5);
    for (const context of contexts) {
      expect(context.nodes[5].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.04);
      expect(context.nodes[0].stop).toHaveBeenLastCalledWith(0.04);
      expect(context.nodes[1].stop).toHaveBeenLastCalledWith(0.04);
      expect(context.close).not.toHaveBeenCalled();
    }
    act(() => contexts[0].nodes[0].onended());
    expect(contexts[0].close).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(250));
    for (const context of contexts) expect(context.close).toHaveBeenCalledOnce();
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoGenBackendSwitch } from './VideoGenLaneSwitches.jsx';

describe('VideoGenBackendSwitch', () => {
  it('wraps provider buttons as whole labels and keeps each provider selectable', () => {
    const onBackendChange = vi.fn();
    const laneEnabled = {
      grok: true,
      fal: true,
      reactor: true,
      runway: true,
      gemini: true,
      higgsfield: true,
      google: true,
    };
    render(<VideoGenBackendSwitch laneEnabled={laneEnabled} backend="local" onBackendChange={onBackendChange} />);

    const strip = screen.getByRole('group', { name: 'Video generation backend' });
    expect(strip.classList.contains('flex-wrap')).toBe(true);
    const buttons = within(strip).getAllByRole('button');
    expect(buttons).toHaveLength(8);
    for (const button of buttons) {
      expect(button.classList.contains('whitespace-nowrap')).toBe(true);
    }
    expect(within(strip).getByRole('button', { name: /Gemini Omni/ })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: 'Local', pressed: true })).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: 'Google', pressed: false }));
    expect(onBackendChange).toHaveBeenCalledWith('google');
  });
});

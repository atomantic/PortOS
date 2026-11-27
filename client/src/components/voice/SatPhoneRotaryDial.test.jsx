import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SatPhoneRotaryDial from './SatPhoneRotaryDial';

describe('SatPhoneRotaryDial', () => {
  it('exposes slider semantics and adjusts volume via keyboard', () => {
    const onVolumeChange = vi.fn();
    const onToggleMute = vi.fn();
    render(
      <SatPhoneRotaryDial
        volume={0.5}
        muted={false}
        onVolumeChange={onVolumeChange}
        onToggleMute={onToggleMute}
      />,
    );

    const slider = screen.getByRole('slider', { name: 'Output volume' });
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    expect(slider).toHaveAttribute('aria-valuetext', '50%');

    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(onVolumeChange).toHaveBeenLastCalledWith(0.55);

    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(onVolumeChange).toHaveBeenLastCalledWith(0.45);

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onVolumeChange).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(slider, { key: 'End' });
    expect(onVolumeChange).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(slider, { key: 'm' });
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('unmutes when adjusted above zero while muted and toggles mute on double-click', () => {
    const onVolumeChange = vi.fn();
    const onToggleMute = vi.fn();
    render(
      <SatPhoneRotaryDial
        volume={0.6}
        muted={true}
        onVolumeChange={onVolumeChange}
        onToggleMute={onToggleMute}
      />,
    );

    const slider = screen.getByRole('slider', { name: 'Output volume' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveAttribute('aria-valuetext', 'Muted');

    fireEvent.doubleClick(slider);
    expect(onToggleMute).toHaveBeenCalledTimes(1);

    fireEvent.wheel(slider, { deltaY: -100 });
    expect(onToggleMute).toHaveBeenCalledWith(false);
    expect(onVolumeChange).toHaveBeenCalledWith(0.65);
  });
});

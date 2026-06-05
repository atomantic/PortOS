import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoraPicker from './LoraPicker';

const renderPicker = (props) =>
  render(
    <MemoryRouter>
      <LoraPicker onChange={vi.fn()} {...props} />
    </MemoryRouter>,
  );

const LORAS = [
  { filename: 'a.safetensors', name: 'Nine-B LoRA', loraCompatKey: 'flux2-9b', runnerFamily: 'flux2' },
  { filename: 'b.safetensors', name: 'Four-B LoRA', loraCompatKey: 'flux2-4b', runnerFamily: 'flux2' },
  { filename: 'c.safetensors', name: 'Unknown-size LoRA', loraCompatKey: 'flux2', runnerFamily: 'flux2' },
  { filename: 'd.safetensors', name: 'MFlux LoRA', loraCompatKey: 'mflux', runnerFamily: 'mflux' },
];

describe('LoraPicker compat filtering', () => {
  it('hides off-size FLUX.2 LoRAs but keeps the matching + unknown-size ones', () => {
    // The bug this fixes: a flux2-9b LoRA offered for a flux2-4b model.
    renderPicker({ availableLoras: LORAS, selected: [], currentCompatKey: 'flux2-4b', currentRunnerFamily: 'flux2' });
    expect(screen.queryByText('Nine-B LoRA')).toBeNull();      // 9b hidden on a 4b model
    expect(screen.getByText('Four-B LoRA')).toBeTruthy();      // exact match shown
    expect(screen.getByText('Unknown-size LoRA')).toBeTruthy();// size unknown → still shown
    expect(screen.queryByText('MFlux LoRA')).toBeNull();       // wrong family hidden
  });

  it('shows the 9B LoRA once the model switches to flux2-9b', () => {
    renderPicker({ availableLoras: LORAS, selected: [], currentCompatKey: 'flux2-9b', currentRunnerFamily: 'flux2' });
    expect(screen.getByText('Nine-B LoRA')).toBeTruthy();
    expect(screen.queryByText('Four-B LoRA')).toBeNull();
  });

  it('falls back to currentRunnerFamily when no compat key is provided (older callers)', () => {
    renderPicker({ availableLoras: LORAS, selected: [], currentRunnerFamily: 'mflux' });
    expect(screen.getByText('MFlux LoRA')).toBeTruthy();
    expect(screen.queryByText('Four-B LoRA')).toBeNull();
  });

  it('treats a LoRA with no compat key as compatible (surface error at run time)', () => {
    const loras = [{ filename: 'legacy.safetensors', name: 'Legacy LoRA', loraCompatKey: null, runnerFamily: null }];
    renderPicker({ availableLoras: loras, selected: [], currentCompatKey: 'flux2-4b', currentRunnerFamily: 'flux2' });
    expect(screen.getByText('Legacy LoRA')).toBeTruthy();
  });
});

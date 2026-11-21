import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: 'day' } }),
}));
vi.mock('../../services/apiGoals.js', () => ({
  getChronotypeEnergySchedule: vi.fn(),
}));

import { getChronotypeEnergySchedule } from '../../services/apiGoals.js';
import { chipColors } from '../../lib/chipContrast';
import ChronotypeOverlay from './ChronotypeOverlay';

const SCHEDULE = {
  zones: [
    { id: 'wake', label: 'Wake Up', startMin: 360, endMin: 390, color: '#f59e0b', opacity: 0.12 },
    { id: 'caffeine-cutoff', label: 'Caffeine Cutoff', startMin: 840, endMin: 840, color: '#ef4444', opacity: 0, marker: true },
  ],
};

// Walk up from the label through every ancestor and multiply `opacity`, the
// same composite the browser paints. A band label must come out at 1.
const effectiveOpacity = (el) => {
  let total = 1;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const o = node.style.opacity;
    if (o !== '') total *= Number(o);
  }
  return total;
};

describe('ChronotypeOverlay', () => {
  beforeEach(() => {
    getChronotypeEnergySchedule.mockResolvedValue(SCHEDULE);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('paints the band tint as an alpha background, never element opacity, so its label stays readable', async () => {
    const { container } = render(<ChronotypeOverlay startHour={0} pxPerHour={60} />);
    const label = await screen.findByText('Wake Up');
    const band = label.parentElement;

    expect(band.style.opacity).toBe('');
    // 0.12 * 255 rounds to 31 = 0x1f, so the tint is a translucent #f59e0b.
    expect(band.style.backgroundColor).not.toBe('');
    expect(band.style.backgroundColor).not.toBe('rgb(245, 158, 11)');
    expect(effectiveOpacity(label)).toBe(1);
    expect(label.style.color).toBe(chipColors('#f59e0b', 'day').color);
    expect(container.querySelectorAll('[style*="opacity"]').length).toBe(0);
  });

  it('keeps marker labels at full strength too', async () => {
    render(<ChronotypeOverlay startHour={0} pxPerHour={60} />);
    const marker = await screen.findByText('Caffeine Cutoff');
    expect(effectiveOpacity(marker)).toBe(1);
  });
});

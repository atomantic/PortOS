import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CosStatsCards from './CosStatsCards';

// text-gray-600 on the translucent warning/error card tints measured 4.08:1 (< WCAG AA 4.5:1).
describe('CosStatsCards sidebar control labels', () => {
  it('keeps the Queue and Agent labels off the low-contrast gray', () => {
    const cos = { status: { running: true, paused: false }, activeAgentCount: 0, pendingTaskCount: 0 };
    render(
      <MemoryRouter>
        <CosStatsCards cos={cos} variant="sidebar" />
      </MemoryRouter>
    );
    for (const name of ['Queue', 'Agent']) {
      const label = screen.getByText(name);
      expect(label.className).toContain('text-port-text-muted');
      expect(label.className).not.toContain('text-gray-600');
    }
  });
});

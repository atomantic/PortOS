import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MediaUsageChip from './MediaUsageChip';

describe('MediaUsageChip', () => {
  it('sets aria-controls only while the usage region is mounted', () => {
    render(
      <MemoryRouter>
        <MediaUsageChip usages={[{ kind: 'universe', id: 'u1', label: 'Demo', path: '/universes/u1' }]} />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('button', { name: /Used ×1/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');

    fireEvent.click(toggle);
    const panel = screen.getByRole('region', { name: 'Where this is used' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
  });
});

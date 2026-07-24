/**
 * SpritePreview — the one way to render a sprite asset. Covers the default
 * (plain checkerboarded image, no interactivity) and the opt-in `zoomable`
 * path, which turns the box into a button that opens a SpriteLightbox.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SpritePreview from './SpritePreview.jsx';

describe('SpritePreview', () => {
  it('renders a non-interactive image by default', () => {
    render(<SpritePreview recordId="field-medic" path="reference/main.png" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/data/sprites/field-medic/reference/main.png');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens an enlarged lightbox when zoomable and clicked', async () => {
    render(<SpritePreview recordId="field-medic" path="reference/walk-south-v1.png" zoomable />);

    const trigger = screen.getByRole('button', { name: /Enlarge/ });
    expect(screen.queryByRole('button', { name: 'Close preview' })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Close preview' })).toBeInTheDocument();
    // The lightbox shows the file name and the enlarged image.
    expect(screen.getByText('walk-south-v1.png')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('button', { name: 'Close preview' })).not.toBeInTheDocument();
  });
});

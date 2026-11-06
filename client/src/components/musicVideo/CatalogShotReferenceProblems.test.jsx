import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CatalogShotReferenceProblems from './CatalogShotReferenceProblems.jsx';

describe('catalog check-in shot references', () => {
  // Uniquely catches a video already switched with no way to move its picks, or a named shot with no way to reach it.
  it('offers the move and opens a named shot', () => {
    const onRemap = vi.fn();
    const onOpenShot = vi.fn();
    render(<CatalogShotReferenceProblems onRemap={onRemap} onOpenShot={onOpenShot}
      checkin={{ movableShotReferences: 1200, shotReferenceProblems: [{ sceneId: 'shot-c', shot: 3, message: 'Shot 3: the catalog check-in does not offer Guest sheet.' }] }} />);
    expect(screen.getByText(/1,200 saved shot references/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move to catalog images' }));
    expect(onRemap).toHaveBeenCalledOnce();
    expect(screen.getByText(/does not offer Guest sheet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 3' }));
    expect(onOpenShot).toHaveBeenCalledWith('shot-c');
  });

  it('renders nothing while every saved reference reaches renders', () => {
    const { container } = render(<CatalogShotReferenceProblems checkin={{ movableShotReferences: 0, shotReferenceProblems: [] }} />);
    expect(container.firstChild).toBeNull();
  });
});

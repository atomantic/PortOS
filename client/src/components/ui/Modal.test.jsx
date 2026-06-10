import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import Modal from './Modal';

afterEach(cleanup);

describe('Modal accessibility', () => {
  it('renders the panel as an accessible dialog over a presentation backdrop', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="Test dialog">
        <p>body</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Test dialog');
    // Backdrop is the dialog's parent and must be presentation-only so it
    // isn't announced as interactive content.
    expect(dialog.parentElement).toHaveAttribute('role', 'presentation');
  });

  it('labels the dialog via ariaLabelledBy (no redundant aria-label)', () => {
    render(
      <Modal open onClose={() => {}} ariaLabelledBy="title-id">
        <h3 id="title-id">My Title</h3>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'title-id');
    expect(dialog).not.toHaveAttribute('aria-label');
  });

  it('closes on Escape by default', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} ariaLabel="x"><p>body</p></Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click but not on panel click', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} ariaLabel="x"><p>body</p></Modal>);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog.parentElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(<Modal open={false} onClose={() => {}} ariaLabel="x"><p>body</p></Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

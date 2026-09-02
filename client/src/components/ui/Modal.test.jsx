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

  it('keeps one top-most Escape stack across module re-evaluation', async () => {
    vi.resetModules();
    const { default: ReevaluatedModal } = await import('./Modal');
    const baseOnClose = vi.fn();
    const topOnClose = vi.fn();

    const { rerender } = render(
      <>
        <Modal open onClose={baseOnClose} ariaLabel="base">
          <p>base body</p>
        </Modal>
        <ReevaluatedModal open onClose={topOnClose} ariaLabel="top">
          <p>top body</p>
        </ReevaluatedModal>
      </>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(topOnClose).toHaveBeenCalledTimes(1);
    expect(baseOnClose).not.toHaveBeenCalled();

    rerender(
      <>
        <Modal open onClose={baseOnClose} ariaLabel="base">
          <p>base body</p>
        </Modal>
        <ReevaluatedModal open={false} onClose={topOnClose} ariaLabel="top">
          <p>top body</p>
        </ReevaluatedModal>
      </>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(baseOnClose).toHaveBeenCalledTimes(1);
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

// The overlay is `fixed inset-0` — the *small* viewport under iOS Safari's
// retractable chrome — and centres with `items-center`, so an unclamped panel
// has its overflow split top and bottom and loses both its title and its
// footer buttons off-screen. Modal owns the clamp so no call site has to.
describe('Modal viewport height clamp', () => {
  it('clamps the panel to the dynamic viewport with no panelClassName', () => {
    render(<Modal open onClose={() => {}} ariaLabel="x"><p>body</p></Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-h-dvh-cap');
    // center align pads the overlay `p-4`, so the panel must give that back.
    expect(dialog).toHaveClass('[--dvh-inset:2rem]');
    expect(dialog).toHaveClass('overflow-auto');
  });

  it("insets by align='top' offset so a top-aligned panel clears the bottom edge", () => {
    render(<Modal open onClose={() => {}} align="top" ariaLabel="x"><p>body</p></Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-h-dvh-cap');
    expect(dialog).toHaveClass('[--dvh-inset:calc(10dvh_+_1rem)]');
    expect(dialog.parentElement).toHaveClass('pt-[10dvh]');
  });

  it('keeps the clamp and appends panelClassName after it', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="x" panelClassName="bg-port-card [--dvh-cap:60dvh]">
        <p>body</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    const cls = dialog.className;
    expect(cls.indexOf('max-h-dvh-cap')).toBeGreaterThan(-1);
    expect(cls.indexOf('max-h-dvh-cap')).toBeLessThan(cls.indexOf('bg-port-card'));
    // A caller shortening the panel sets the cap variable, not a raw vh.
    expect(dialog).toHaveClass('[--dvh-cap:60dvh]');
  });

  it("yields the scroll utility to a caller's own overflow declaration", () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="x" panelClassName="overflow-hidden flex flex-col">
        <p>body</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-h-dvh-cap');
    // Tailwind precedence follows CSS source order, so emitting both would be
    // a coin flip rather than an override.
    expect(dialog).not.toHaveClass('overflow-auto');
  });

  it('still scrolls below a breakpoint when the caller only sets a variant overflow', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="x" panelClassName="lg:overflow-hidden">
        <p>body</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    // `lg:overflow-hidden` applies only inside its media query — where it
    // outranks the base utility anyway — so suppressing the default would
    // leave the panel clamped but unscrollable on a phone.
    expect(dialog).toHaveClass('overflow-auto');
  });
});

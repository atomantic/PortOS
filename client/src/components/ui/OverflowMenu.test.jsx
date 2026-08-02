import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OverflowMenu from './OverflowMenu';

const items = (overrides = {}) => ([
  { id: 'archive', label: 'Archive', onSelect: vi.fn(), ...overrides.archive },
  { id: 'delete', label: 'Delete', tone: 'danger', onSelect: vi.fn(), ...overrides.delete },
]);

describe('OverflowMenu', () => {
  it('renders nothing when there are no items', () => {
    const { container } = render(<OverflowMenu label="More actions" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps items hidden until the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu label="More actions" items={items()} />);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();

    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);

    expect(screen.getByRole('menu')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('invokes onSelect and closes the menu when an item is chosen', async () => {
    const user = userEvent.setup();
    const list = items();
    render(<OverflowMenu label="More actions" items={list} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(list[1].onSelect).toHaveBeenCalledTimes(1);
    expect(list[0].onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions' }));
  });

  it('is keyboard operable: ArrowDown opens and focuses the first item, arrows cycle, Escape closes', async () => {
    const user = userEvent.setup();
    render(<OverflowMenu label="More actions" items={items()} />);

    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('skips disabled items when moving focus and never fires their handler', async () => {
    const user = userEvent.setup();
    const list = items({ archive: { disabled: true } });
    render(<OverflowMenu label="More actions" items={list} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));

    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(list[0].onSelect).not.toHaveBeenCalled();
  });

  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">outside</button>
        <OverflowMenu label="More actions" items={items()} />
      </div>
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

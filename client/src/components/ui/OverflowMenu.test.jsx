import { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
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
    expect(screen.getByRole('menu').parentElement).toBe(document.body);
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

  it('exposes the trigger through an external triggerRef so callers can return focus to it', async () => {
    const user = userEvent.setup();
    const Harness = () => {
      const triggerRef = useRef(null);
      return (
        <div>
          <button type="button" onClick={() => triggerRef.current?.focus()}>refocus</button>
          <OverflowMenu label="More actions" items={items()} triggerRef={triggerRef} />
        </div>
      );
    };
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'refocus' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions' }));
  });

  it('closes on Tab and advances from the trigger rather than dropping focus on the body', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <OverflowMenu label="More actions" items={items()} />
        <button type="button">after</button>
      </div>
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }));

    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
  });

  it('closes on Shift+Tab and steps back to the control before the trigger', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">before</button>
        <OverflowMenu label="More actions" items={items()} />
      </div>
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.tab({ shift: true });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'before' }));
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

  // A page header can demote its navigation actions here (#5653) only if they
  // stay real anchors — a <button> would lose middle-click / open-in-new-tab.
  it('renders a `to` item as a link and closes the menu on activation', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <OverflowMenu
          label="More actions"
          items={[{ id: 'compare', label: 'Compare local models', to: '/models/performance' }]}
        />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Compare local models' });
    expect(item.tagName).toBe('A');
    expect(item).toHaveAttribute('href', '/models/performance');

    const trigger = screen.getByRole('button', { name: 'More actions' });
    await user.click(item);
    expect(screen.queryByRole('menu')).toBeNull();
    // The activated anchor unmounts with the menu, so focus has to be handed
    // back or a keyboard user is stranded on <body>.
    expect(document.activeElement).toBe(trigger);
  });
});

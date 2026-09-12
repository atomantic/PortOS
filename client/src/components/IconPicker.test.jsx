import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IconPicker from './IconPicker';
import Drawer from './Drawer';

function Form() {
  const [icon, setIcon] = useState('package');
  return <><IconPicker value={icon} onChange={setIcon} /><button type="button">Next field</button></>;
}

describe('IconPicker', () => {
  it('keeps Escape inside the picker and resumes tabbing within its drawer', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Drawer open title="Edit App" onClose={onClose}><Form /></Drawer>);
    const trigger = screen.getByRole('button', { name: 'Icon picker' });
    trigger.focus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const choices = document.getElementById(trigger.getAttribute('aria-controls'));
    expect(choices).toBeInTheDocument();
    await user.tab();
    expect(choices).toContainElement(document.activeElement);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    expect(choices).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next field' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('updates the controlled value and restores focus when a choice is activated', async () => {
    const user = userEvent.setup();
    render(<Form />);
    const trigger = screen.getByRole('button', { name: 'Icon picker' });
    await user.click(trigger);
    const choice = screen.getByRole('button', { name: 'web' });
    choice.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveTextContent('web');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('dismisses by pointer without stealing focus from another form field', async () => {
    const user = userEvent.setup();
    const { container } = render(<Form />);
    const trigger = screen.getByRole('button', { name: 'Icon picker' });
    await user.click(trigger);
    const next = screen.getByRole('button', { name: 'Next field' });
    next.focus();
    fireEvent.click(container.querySelector('.fixed[aria-hidden="true"]'));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(next).toHaveFocus();
  });
});

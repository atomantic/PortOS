import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UnsavedChangesConfirm from './UnsavedChangesConfirm';

const guard = (blocked, reset = vi.fn()) => ({ blocked, proceed: vi.fn(), reset });

const renderRow = (props) => render(
  <UnsavedChangesConfirm
    question="Discard your unsaved changes?"
    label="Discard unsaved changes to Example Work"
    onDiscard={() => {}}
    {...props}
  />,
);

describe('UnsavedChangesConfirm', () => {
  it('renders nothing while no navigation is parked', () => {
    renderRow({ guard: guard(false) });
    expect(screen.queryByText('Discard your unsaved changes?')).toBeNull();
  });

  it('renders the confirm once the guard blocks', () => {
    renderRow({ guard: guard(true) });
    expect(screen.getByText('Discard your unsaved changes?')).toBeInTheDocument();
    expect(screen.getByText('Discard')).toBeInTheDocument();
    expect(screen.getByText('Keep editing')).toBeInTheDocument();
  });

  it('stays down while the caller gate is closed (a save in flight)', () => {
    renderRow({ guard: guard(true), when: false });
    expect(screen.queryByText('Discard your unsaved changes?')).toBeNull();
  });

  it('wires Discard to onDiscard and Keep editing to the guard reset', () => {
    const onDiscard = vi.fn();
    const reset = vi.fn();
    renderRow({ guard: guard(true, reset), onDiscard });

    fireEvent.click(screen.getByText('Discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Keep editing'));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

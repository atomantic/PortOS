import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import EntityCombobox from './EntityCombobox';

const items = [
  { id: 'a', name: 'Cyberpunk 2099', subtitle: 'Neon rain' },
  { id: 'b', name: 'Salt Run', subtitle: 'Foundry city' },
  { id: 'c', name: 'Choir Awakens', subtitle: 'Empty cathedral' },
];

describe('EntityCombobox', () => {
  it('lists every item (except the selected one) when opened on a selection', async () => {
    const user = userEvent.setup();
    render(
      <EntityCombobox
        items={items}
        selectedId="a"
        value="Cyberpunk 2099"
        onChange={() => {}}
        onPick={() => {}}
        onCreate={() => {}}
        inputId="test-universe"
        noun="universe"
      />
    );
    await user.click(screen.getByRole('button', { name: /Open universe list/i }));
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Salt Run')).toBeInTheDocument();
    expect(within(list).getByText('Choir Awakens')).toBeInTheDocument();
    // The selected item is excluded (clicking it would no-op).
    expect(within(list).queryByText('Cyberpunk 2099')).toBeNull();
    // Exact match on an existing name → no create row.
    expect(within(list).queryByText(/New universe/i)).toBeNull();
  });

  it('calls onPick with the full item when an option is clicked', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <EntityCombobox
        items={items}
        selectedId={null}
        value=""
        onChange={() => {}}
        onPick={onPick}
        onCreate={() => {}}
        inputId="test-universe"
        noun="universe"
      />
    );
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByText('Salt Run'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'b', name: 'Salt Run' }));
  });

  it('shows a create row with the custom prefix when the query has no exact match', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <EntityCombobox
        items={items}
        selectedId={null}
        value="Brand New World"
        onChange={() => {}}
        onPick={() => {}}
        onCreate={onCreate}
        inputId="test-universe"
        noun="universe"
        createPrefix="New universe"
      />
    );
    await user.click(screen.getByRole('combobox'));
    const createBtn = screen.getByRole('option', { name: /New universe/i });
    expect(createBtn).toHaveTextContent('Brand New World');
    await user.click(createBtn);
    expect(onCreate).toHaveBeenCalled();
  });

  it('omits the create row entirely when onCreate is not provided', async () => {
    const user = userEvent.setup();
    render(
      <EntityCombobox
        items={items}
        selectedId={null}
        value="Brand New World"
        onChange={() => {}}
        onPick={() => {}}
        inputId="test-series"
        noun="series"
      />
    );
    await user.click(screen.getByRole('combobox'));
    const list = screen.getByRole('listbox');
    expect(within(list).getByText(/No matches/i)).toBeInTheDocument();
  });

  it('renders the custom empty hint when there are no items', async () => {
    const user = userEvent.setup();
    render(
      <EntityCombobox
        items={[]}
        selectedId={null}
        value=""
        onChange={() => {}}
        onPick={() => {}}
        inputId="test-series"
        noun="series"
        emptyNoItems="Pick a universe above to list its series, or type a new name."
      />
    );
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByText(/Pick a universe above to list its series/i)).toBeInTheDocument();
  });
});

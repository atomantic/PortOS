import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { CategoryEditor, TrunkView, OtherTab } from './UniverseBuilder';

// MemoryRouter wrapper — UniverseBuilder.jsx imports react-router-dom hooks at
// module scope, so the test harness needs a router context even when the
// extracted component doesn't read URL state itself.
const renderWithRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

const sampleVariation = { label: 'Rogue navigator', prompt: 'A scrappy navigator with a tarnished sextant.' };

describe('CategoryEditor — promote wiring', () => {
  const renderEditor = ({ canPromote = true, bucketKind = 'characters', onPromote } = {}) => {
    renderWithRouter(
      <CategoryEditor
        category="heroes"
        variations={[sampleVariation]}
        onChange={() => {}}
        canPromote={canPromote}
        bucketKind={bucketKind}
        onPromote={onPromote}
      />
    );
  };

  it('disables the promote button when canPromote is false', () => {
    renderEditor({ canPromote: false, onPromote: vi.fn() });

    expect(screen.getByRole('button', { name: /Save the universe first to enable promote/i })).toBeDisabled();
  });

  it('fires onPromote directly with no targetKind for a kinded bucket', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderEditor({ onPromote });

    const promoteBtn = screen.getByRole('button', { name: /Promote to canon — LLM expands/i });
    expect(promoteBtn).toBeEnabled();
    expect(promoteBtn).not.toHaveAttribute('aria-haspopup');

    await user.click(promoteBtn);
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote).toHaveBeenCalledWith(sampleVariation, undefined);
  });

  it('opens a trunk-picker menu when bucketKind is "other" instead of promoting directly', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderEditor({ bucketKind: null, onPromote });

    const promoteBtn = screen.getByRole('button', { name: /Promote to canon — pick a trunk/i });
    expect(promoteBtn).toHaveAttribute('aria-haspopup', 'menu');
    expect(promoteBtn).toHaveAttribute('aria-expanded', 'false');

    await user.click(promoteBtn);
    expect(onPromote).not.toHaveBeenCalled();
    expect(promoteBtn).toHaveAttribute('aria-expanded', 'true');

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText(/Promote to canon as/i)).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Cast' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Places' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Objects' })).toBeInTheDocument();
  });

  it('clicking a picker option invokes onPromote with the chosen targetKind', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderEditor({ bucketKind: null, onPromote });

    await user.click(screen.getByRole('button', { name: /Promote to canon — pick a trunk/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Places' }));

    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote).toHaveBeenCalledWith(sampleVariation, { targetKind: 'places' });
  });
});

describe('TrunkView — Bulk-render-all button', () => {
  const baseTrunk = { id: 'cast', kind: 'characters', label: 'Cast' };
  const noop = () => {};
  const baseProps = {
    selectedId: 'u1',
    activeBucket: 'heroes',
    setBucket: noop,
    canRender: true,
    canPromote: true,
    imageCfg: null,
    onUniverseChange: noop,
    onRemoveBucket: noop,
    onUpdateBucket: noop,
    onGenerateInBucket: noop,
    onPromoteVariation: noop,
    onBulkRenderBucket: noop,
    onRenderVariation: noop,
    onBulkRenderTrunk: noop,
    onAddBucket: noop,
  };

  it('disables "Bulk-render all" when the trunk has no canon and no variations', () => {
    renderWithRouter(
      <TrunkView
        {...baseProps}
        trunk={baseTrunk}
        draft={{ id: 'u1', characters: [], categories: { heroes: { kind: 'characters', variations: [] } } }}
        buckets={['heroes']}
      />
    );

    const bulkBtn = screen.getByRole('button', { name: /Bulk-render all \(0\)/i });
    expect(bulkBtn).toBeDisabled();
  });

  it('enables "Bulk-render all" with the right count when variations exist', () => {
    renderWithRouter(
      <TrunkView
        {...baseProps}
        trunk={baseTrunk}
        draft={{
          id: 'u1',
          characters: [],
          categories: {
            heroes: { kind: 'characters', variations: [{ label: 'a', prompt: 'p' }, { label: 'b', prompt: 'q' }] },
            villains: { kind: 'characters', variations: [{ label: 'c', prompt: 'r' }] },
          },
        }}
        buckets={['heroes', 'villains']}
      />
    );

    const bulkBtn = screen.getByRole('button', { name: /Bulk-render all \(3\)/i });
    expect(bulkBtn).toBeEnabled();
  });
});

describe('OtherTab — Auto-sort button', () => {
  const noop = () => {};
  const baseProps = {
    buckets: ['mysteries'],
    activeBucket: 'mysteries',
    setBucket: noop,
    canRender: true,
    canPromote: true,
    onUpdateBucket: noop,
    onRemoveBucket: noop,
    onGenerateInBucket: noop,
    onPromoteVariation: noop,
    onBulkRenderBucket: noop,
    onRenderVariation: noop,
    onAssignBucketKind: noop,
    draft: {
      id: 'u1',
      categories: {
        mysteries: { kind: 'other', variations: [{ label: 'a', prompt: 'p' }] },
      },
    },
  };

  it('fires onAutoSort when the Auto-sort button is clicked', async () => {
    const onAutoSort = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<OtherTab {...baseProps} onAutoSort={onAutoSort} />);

    const btn = screen.getByRole('button', { name: /Auto-sort with AI/i });
    expect(btn).toBeEnabled();
    await user.click(btn);
    expect(onAutoSort).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows "Sorting…" while autoSorting is true', () => {
    const onAutoSort = vi.fn();
    renderWithRouter(<OtherTab {...baseProps} onAutoSort={onAutoSort} autoSorting />);

    const btn = screen.getByRole('button', { name: /Sorting…/i });
    expect(btn).toBeDisabled();
    // The disabled state must visibly block re-entry, not just rely on the
    // page-level autoSortingRef guard (which the user can't see).
    expect(screen.queryByRole('button', { name: /^Auto-sort with AI$/i })).toBeNull();
  });
});

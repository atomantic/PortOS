import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../services/apiCatalogTypes', () => ({
  listCatalogTypes: vi.fn(),
}));

import { CatalogTypesProvider, useCatalogTypes } from './useCatalogTypes.jsx';
import { listCatalogTypes } from '../services/apiCatalogTypes';

// Tiny consumer that renders the hook output for assertions.
function Probe() {
  const { types, getType, ids, loading } = useCatalogTypes();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="ids">{ids.join(',')}</span>
      <span data-testid="faction-label">{getType('faction')?.label || ''}</span>
      <span data-testid="count">{types.length}</span>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useCatalogTypes', () => {
  it('returns the static system fallback synchronously on first render', () => {
    // Never resolves — first render must still show the built-in six.
    listCatalogTypes.mockReturnValue(new Promise(() => {}));
    render(<CatalogTypesProvider><Probe /></CatalogTypesProvider>);
    expect(screen.getByTestId('ids').textContent).toBe('character,place,object,idea,scene,concept');
    expect(screen.getByTestId('loading').textContent).toBe('true');
  });

  it('merges a user type from the server after the fetch resolves', async () => {
    listCatalogTypes.mockResolvedValue({
      types: [
        { id: 'character', label: 'Character', system: true },
        { id: 'faction', label: 'Faction', system: false, primaryContentKey: 'creed', fields: [{ key: 'creed', label: 'Creed', kind: 'longtext' }] },
      ],
    });
    render(<CatalogTypesProvider><Probe /></CatalogTypesProvider>);
    await waitFor(() => expect(screen.getByTestId('faction-label').textContent).toBe('Faction'));
    // System types come first; the user type is appended (7 total).
    expect(screen.getByTestId('count').textContent).toBe('7');
    expect(screen.getByTestId('ids').textContent.endsWith(',faction')).toBe(true);
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });

  it('keeps the static fallback when the fetch fails', async () => {
    listCatalogTypes.mockRejectedValue(new Error('offline'));
    render(<CatalogTypesProvider><Probe /></CatalogTypesProvider>);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('count').textContent).toBe('6');
  });
});

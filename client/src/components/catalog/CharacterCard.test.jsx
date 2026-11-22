import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import CharacterCard from './CharacterCard';

vi.mock('./CatalogLockButton', () => ({ default: () => null }));
vi.mock('./CatalogImageAction', () => ({ default: () => null }));

const ingredient = { id: 'example-hero', name: 'Example Hero', type: 'character', payload: {} };

const renderCard = (props) => render(<MemoryRouter>
  <CharacterCard ingredient={ingredient} to="/casting/example-hero" {...props} />
</MemoryRouter>);

describe('CharacterCard name heading rank', () => {
  it('defaults to h3 so it nests under a story or kind heading', () => {
    renderCard();
    expect(screen.getByRole('heading', { level: 3, name: 'Example Hero' })).toBeInTheDocument();
  });

  it('renders at the caller-provided level so a page-level grid keeps the outline stepping one level', () => {
    renderCard({ headingLevel: 2 });
    expect(screen.getByRole('heading', { level: 2, name: 'Example Hero' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Example Hero' })).toBeNull();
  });
});

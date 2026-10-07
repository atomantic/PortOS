import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AgentMemoriesUsed from './AgentMemoriesUsed';

const renderList = (injectedMemories) => render(<MemoryRouter><AgentMemoriesUsed injectedMemories={injectedMemories} /></MemoryRouter>);

describe('AgentMemoriesUsed', () => {
  it('links each injected memory to its Memory tab detail route', () => {
    renderList([{ id: 'abcdef12-0000', version: null, relevance: 0.5 }]);
    expect(screen.getByText('Memories used (1)')).toBeTruthy();
    expect(screen.getByRole('link', { name: /abcdef12/ }).getAttribute('href')).toBe('/cos/memory/abcdef12-0000');
  });

  it('renders nothing for an empty list or a record that predates the field', () => {
    expect(renderList([]).container.innerHTML).toBe('');
    expect(renderList(undefined).container.innerHTML).toBe('');
  });
});

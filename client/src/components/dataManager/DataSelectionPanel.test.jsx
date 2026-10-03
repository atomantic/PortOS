import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import DataSelectionPanel from './DataSelectionPanel';

const overview = {
  dataDir: 'data',
  totalSize: 2048,
  categories: [],
  disk: null,
};

describe('DataSelectionPanel storage summary', () => {
  it('identifies the overview as file storage and links to database size', () => {
    render(
      <MemoryRouter>
        <DataSelectionPanel overview={overview} totalFiles={2} selected={null} detail={null} onSelect={() => {}} onShowActions={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Files in data/')).toBeInTheDocument();
    expect(screen.getByText(/Live PostgreSQL data is not included/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Database settings' })).toHaveAttribute('href', '/settings/database');
  });

  it('keeps the exclusion explanation off category details', () => {
    render(
      <MemoryRouter>
        <DataSelectionPanel overview={overview} totalFiles={2} selected={{ key: 'cache', label: 'Cache', path: 'data/cache/', size: 1024, fileCount: 1 }} detail={null} onSelect={() => {}} onShowActions={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getByText('data/cache/')).toBeInTheDocument();
    expect(screen.queryByText(/Live PostgreSQL data/)).not.toBeInTheDocument();
  });
});

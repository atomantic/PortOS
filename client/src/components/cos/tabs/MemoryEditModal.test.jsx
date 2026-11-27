import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MemoryEditModal from './MemoryEditModal';
import { getMemory, getMemoryVersions, getMemoryRuns, updateMemory } from '../../../services/apiMemory.js';

vi.mock('../../../services/apiMemory.js', () => ({
  getMemory: vi.fn(), getMemoryVersions: vi.fn(), getMemoryVersion: vi.fn(), getMemoryRuns: vi.fn(), updateMemory: vi.fn()
}));
vi.mock('../../ui/Toast');
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: socket }));

beforeEach(() => {
  vi.clearAllMocks();
  getMemory.mockResolvedValue({ id: 'memory-example', content: 'Original content', summary: 'Summary', type: 'fact', category: 'values', sourceAppId: 'brain', tags: ['preference'], importance: 0.75, confidence: 0.9, version: 4, status: 'active' });
  getMemoryVersions.mockResolvedValue({ versions: [] });
  getMemoryRuns.mockResolvedValue({ runs: [] });
});

const renderEditor = (apps = []) => render(<MemoryRouter><MemoryEditModal memory={{ id: 'memory-example' }} apps={apps} onSave={vi.fn()} onClose={vi.fn()} /></MemoryRouter>);

describe('MemoryEditModal', () => {
  it('hydrates and round-trips values, Brain, and custom metadata', async () => {
    getMemory.mockResolvedValue({ id: 'memory-example', content: 'Original content', type: 'fact', category: 'values', sourceAppId: 'custom-app', tags: ['preference'], importance: 0.75, confidence: 0.9, version: 4, status: 'active' });
    updateMemory.mockResolvedValue({ id: 'memory-example', version: 5 });
    renderEditor([]);
    await screen.findByDisplayValue('Original content');
    expect(screen.getByLabelText('Category')).toHaveValue('values');
    expect(screen.getByLabelText('Category').selectedOptions[0]).toHaveTextContent('Values');
    expect(screen.getByLabelText('Associated App')).toHaveValue('custom-app');
    expect(screen.getByLabelText('Associated App').selectedOptions[0]).toHaveTextContent('custom-app');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateMemory).toHaveBeenCalledWith('memory-example', expect.objectContaining({
      expectedVersion: 4, category: 'values', sourceAppId: 'custom-app'
    }), { silent: true }));
  });

  it('exposes clear accessible controls and round-trips a Brain association', async () => {
    updateMemory.mockResolvedValue({ id: 'memory-example', version: 5 });
    renderEditor([]);
    await screen.findByDisplayValue('Original content');
    const typeGroup = screen.getByRole('group', { name: 'Memory type' });
    expect(within(typeGroup).getByRole('button', { name: 'fact' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Remove tag preference' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add tag' })).toBeInTheDocument();
    expect(screen.getByLabelText('Associated App')).toHaveValue('brain');
    expect(screen.getByLabelText('Associated App').selectedOptions[0]).toHaveTextContent('Brain');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateMemory).toHaveBeenCalledWith('memory-example', expect.objectContaining({ category: 'values', sourceAppId: 'brain' }), { silent: true }));
  });
});

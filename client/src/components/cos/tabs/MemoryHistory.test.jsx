import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import MemoryEditModal from './MemoryEditModal';
import * as api from '../../../services/api';

vi.mock('../../../services/api', () => ({
  getMemory: vi.fn(), getMemoryVersions: vi.fn(), getMemoryVersion: vi.fn(),
  updateMemory: vi.fn(), getMemoryRuns: vi.fn()
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  api.getMemory.mockResolvedValue({
    id: 'example-memory', content: 'Current text', summary: 'Current', type: 'fact',
    version: 3, status: 'archived', archiveReason: 'Corrected', supersededBy: ['replacement']
  });
  api.getMemoryVersions.mockResolvedValue({
    versions: [{ version: 2, changeReason: 'Earlier correction', createdAt: '2026-01-01T00:00:00.000Z' }]
  });
  api.getMemoryVersion.mockResolvedValue({ version: 2, content: 'Earlier text', summary: 'Earlier', type: 'fact', tags: [] });
  api.getMemoryRuns.mockResolvedValue({ runs: [] });
});

describe('Memory detail history', () => {
  it('loads earlier text on demand, links its replacement and guards saves with the loaded version', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    api.updateMemory.mockResolvedValue({ id: 'example-memory', version: 4 });
    render(<MemoryRouter><MemoryEditModal memory={{ id: 'example-memory' }} apps={[]} onSave={onSave} onClose={() => {}} /></MemoryRouter>);
    expect(await screen.findByDisplayValue('Current text')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'View replacement memory' })).toHaveAttribute('href', '/cos/memory/replacement');
    await user.click(await screen.findByRole('button', { name: /Version 2/ }));
    expect(await screen.findByText('Earlier text')).toBeTruthy();
    expect(screen.getByDisplayValue('Current text')).toBeTruthy();
    await user.type(screen.getByLabelText('Reason for change'), 'New evidence');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updateMemory).toHaveBeenCalledWith('example-memory',
      expect.objectContaining({ expectedVersion: 3, changeReason: 'New evidence', content: 'Current text' }),
      { silent: true }));
    expect(onSave).toHaveBeenCalled();
  });
});

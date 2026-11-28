import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../services/apiPrivacy.js', () => ({
  declarePrivacyChange: vi.fn(),
}));
vi.mock('../ui/Toast');

import DeclareChangeDrawer from './DeclareChangeDrawer';
import { declarePrivacyChange } from '../../services/apiPrivacy.js';

const VAULT_RECORDS = [
  { id: 'rec-1', type: 'phone', label: 'Old mobile', maskedValue: '•••-0199', status: 'current' },
];

describe('DeclareChangeDrawer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('declares a replacement change with inline label and value', async () => {
    declarePrivacyChange.mockResolvedValue({ id: 'ev-1' });
    const onDeclared = vi.fn();
    render(<DeclareChangeDrawer open vaultRecords={VAULT_RECORDS} onClose={vi.fn()} onDeclared={onDeclared} />);

    fireEvent.change(screen.getByLabelText('New value label'), { target: { value: 'New mobile' } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: '555-0142' } });
    fireEvent.click(screen.getByRole('button', { name: 'Declare change' }));

    await waitFor(() => expect(declarePrivacyChange).toHaveBeenCalledWith(
      {
        vaultRecordId: 'rec-1',
        replacement: { label: 'New mobile', value: '555-0142' },
        kind: 'phone_change',
        note: undefined,
      },
      { silent: true },
    ));
    expect(onDeclared).toHaveBeenCalledWith({ id: 'ev-1' });
  });

  it('declares a removal-only change without replacement fields', async () => {
    declarePrivacyChange.mockResolvedValue({ id: 'ev-2' });
    const onDeclared = vi.fn();
    render(<DeclareChangeDrawer open vaultRecords={VAULT_RECORDS} onClose={vi.fn()} onDeclared={onDeclared} />);

    fireEvent.click(screen.getByLabelText('Removed with no replacement'));
    expect(screen.queryByLabelText('New value label')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New value')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Disconnected line' } });
    fireEvent.click(screen.getByRole('button', { name: 'Declare change' }));

    await waitFor(() => expect(declarePrivacyChange).toHaveBeenCalledWith(
      {
        vaultRecordId: 'rec-1',
        kind: 'phone_change',
        note: 'Disconnected line',
      },
      { silent: true },
    ));
    expect(onDeclared).toHaveBeenCalledWith({ id: 'ev-2' });
  });
});

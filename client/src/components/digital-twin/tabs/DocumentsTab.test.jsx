import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getDigitalTwinDocuments: vi.fn(),
  getDigitalTwinDocument: vi.fn(),
  updateSoulDocument: vi.fn(),
  createSoulDocument: vi.fn(),
  deleteSoulDocument: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}));

import DocumentsTab from './DocumentsTab';
import {
  getDigitalTwinDocuments,
  getDigitalTwinDocument,
  updateSoulDocument,
  deleteSoulDocument,
} from '../../../services/apiDigitalTwin.js';
import toast from '../../ui/Toast';

const Where = () => <div data-testid="where">{useLocation().search}</div>;
const renderTab = (onRefresh = vi.fn(), entry = '/digital-twin/documents') => render(<MemoryRouter initialEntries={[entry]}><DocumentsTab onRefresh={onRefresh} /><Where /></MemoryRouter>);
const DOC = { id: 'doc-1', title: 'Core Values', category: 'core', enabled: true, weight: 5, content: 'original', lastModified: '2026-01-01T00:00:00.000Z' };

describe('DocumentsTab failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDigitalTwinDocuments.mockResolvedValue([DOC]);
    getDigitalTwinDocument.mockResolvedValue(DOC);
  });

  it('re-enables Save after a rejected update so the unsaved edit can be retried', async () => {
    updateSoulDocument.mockRejectedValueOnce(new Error('Document is locked'));
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Core Values/ }));
    await user.type(await screen.findByLabelText('Soul document'), ' edited');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateSoulDocument).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
    expect(toast.success).not.toHaveBeenCalled();

    // The retry goes through: the editor was not stranded behind a stuck `saving` flag.
    updateSoulDocument.mockResolvedValueOnce({ ...DOC, content: 'original edited' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Document saved'));
  });
});

describe('DocumentsTab failed load', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a retryable load error instead of "No documents yet", then the list once Retry succeeds', async () => {
    getDigitalTwinDocuments.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([DOC]);
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load documents');
    expect(screen.queryByText('No documents yet')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Core Values/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps "No documents yet" for a genuinely empty library', async () => {
    getDigitalTwinDocuments.mockResolvedValue([]);
    renderTab();
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('DocumentsTab inline editing and deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDigitalTwinDocuments.mockResolvedValue([DOC]);
    getDigitalTwinDocument.mockResolvedValue(DOC);
  });

  it('opens ?doc=<id> directly editable, saves with one PUT and no refetch', async () => {
    const user = userEvent.setup();
    renderTab(vi.fn(), '/digital-twin/documents?doc=doc-1');
    const box = await screen.findByLabelText('Soul document');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    updateSoulDocument.mockResolvedValueOnce({ ...DOC, content: 'original!' });
    await user.type(box, '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Document saved'));
    expect(updateSoulDocument).toHaveBeenCalledTimes(1);
    expect(getDigitalTwinDocuments).toHaveBeenCalledTimes(1);
    expect(getDigitalTwinDocument).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('selecting a row writes ?doc= and deleting confirms inline without a dialog', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: /Core Values/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('?doc=doc-1');
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    deleteSoulDocument.mockResolvedValueOnce();
    await user.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(deleteSoulDocument).toHaveBeenCalledWith('doc-1'));
  });
});

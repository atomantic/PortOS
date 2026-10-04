import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BeeperNewConversation from './BeeperNewConversation';
import { createBeeperConversation } from '../../../services/apiBeeper';

vi.mock('../../../services/apiBeeper', () => ({ createBeeperConversation: vi.fn() }));
const accounts = [{ accountId: 'example-account', displayName: 'Example network' }];
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('new Beeper conversation', () => {
  it('opens the returned mirror identity and submits no message content', async () => {
    const onCreated = vi.fn();
    createBeeperConversation.mockResolvedValue({ id: 'mirror-chat' });
    render(<BeeperNewConversation accounts={accounts} onCreated={onCreated} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Recipient ID'), { target: { value: ' recipient-example ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('mirror-chat'));
    expect(createBeeperConversation).toHaveBeenCalledWith({
      accountId: 'example-account', participantId: 'recipient-example',
    }, { silent: true });
  });

  it('keeps a failed creation visible and guards repeated submits while pending', async () => {
    let reject;
    createBeeperConversation.mockReturnValue(new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
    const onCreated = vi.fn();
    render(<BeeperNewConversation accounts={accounts} onCreated={onCreated} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Recipient ID'), { target: { value: 'recipient-example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Opening…' }).closest('form'));
    expect(createBeeperConversation).toHaveBeenCalledTimes(1);
    reject(new Error('Network requires a first message'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network requires a first message');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Recipient ID')).toHaveValue('recipient-example');
  });
});

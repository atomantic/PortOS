import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AddToThreadButton from './AddToThreadButton';
import * as api from '../../services/api';
import toast from '../ui/Toast';

vi.mock('../../services/api', () => ({
  listThreads: vi.fn(),
  attachToThread: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('AddToThreadButton', () => {
  const sampleRef = {
    kind: 'github.issue',
    id: 'https://github.com/atomantic/PortOS/issues/100',
    label: '#100 Fix widget layout',
  };

  const sampleThreads = [
    { id: 't1', title: 'Sprint planning', status: 'open', nextAction: 'Review backlog' },
    { id: 't2', title: 'Refactor auth', status: 'waiting', waitingOn: 'Alice' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.listThreads.mockResolvedValue({ threads: sampleThreads });
    api.attachToThread.mockResolvedValue({ thread: { id: 't1', title: 'Sprint planning' }, created: false });
  });

  it('renders a button with accessible label and title', () => {
    render(<AddToThreadButton threadRef={sampleRef} />);
    const btn = screen.getByRole('button', { name: 'Add to Brain thread' });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('renders buttonText when provided', () => {
    render(<AddToThreadButton threadRef={sampleRef} buttonText="Thread" />);
    const btn = screen.getByRole('button', { name: 'Thread' });
    expect(btn).toBeInTheDocument();
  });

  it('disables the button when no ref is provided', () => {
    render(<AddToThreadButton />);
    const btn = screen.getByRole('button', { name: 'Add to Brain thread' });
    expect(btn).toBeDisabled();
  });

  it('opens the popover and fetches open threads when clicked', async () => {
    render(<AddToThreadButton threadRef={sampleRef} />);
    const btn = screen.getByRole('button', { name: 'Add to Brain thread' });
    fireEvent.click(btn);

    expect(api.listThreads).toHaveBeenCalledWith(
      { status: 'open,waiting,someday' },
      { silent: true }
    );

    await waitFor(() => {
      expect(screen.getByText('Add to Brain thread')).toBeInTheDocument();
      expect(screen.getByText('Attaching:')).toBeInTheDocument();
      expect(screen.getByText('#100 Fix widget layout')).toBeInTheDocument();
    });
  });

  it('attaches to an existing thread when selected from combobox', async () => {
    const onAttached = vi.fn();
    render(<AddToThreadButton threadRef={sampleRef} onAttached={onAttached} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Brain thread' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);

    await waitFor(() => {
      expect(screen.getByText('Sprint planning')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Sprint planning'));

    await waitFor(() => {
      expect(api.attachToThread).toHaveBeenCalledWith({
        threadId: 't1',
        ref: {
          kind: 'github.issue',
          id: 'https://github.com/atomantic/PortOS/issues/100',
          label: '#100 Fix widget layout',
        },
      });
      expect(toast.success).toHaveBeenCalledWith('Attached to thread "Sprint planning"');
      expect(onAttached).toHaveBeenCalled();
    });
  });

  it('creates a new thread and attaches when committing a typed name', async () => {
    api.attachToThread.mockResolvedValue({ thread: { id: 't3', title: 'New Open Loop' }, created: true });
    render(<AddToThreadButton threadRef={sampleRef} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Brain thread' }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search open threads or type name…')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('Search open threads or type name…');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'New Open Loop' } });

    await waitFor(() => {
      expect(screen.getByText(/New thread “New Open Loop”/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/New thread “New Open Loop”/i));

    await waitFor(() => {
      expect(api.attachToThread).toHaveBeenCalledWith({
        title: 'New Open Loop',
        ref: {
          kind: 'github.issue',
          id: 'https://github.com/atomantic/PortOS/issues/100',
          label: '#100 Fix widget layout',
        },
      });
      expect(toast.success).toHaveBeenCalledWith('Created thread "New Open Loop"');
    });
  });

  it('supports individual kind, id, label props', async () => {
    render(
      <AddToThreadButton
        kind="message"
        id="acc-1:msg-99"
        label="Quarterly Review Notes"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to Brain thread' }));

    await waitFor(() => {
      expect(screen.getByText('Quarterly Review Notes')).toBeInTheDocument();
    });

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);

    await waitFor(() => {
      expect(screen.getByText('Sprint planning')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Sprint planning'));

    await waitFor(() => {
      expect(api.attachToThread).toHaveBeenCalledWith({
        threadId: 't1',
        ref: {
          kind: 'message',
          id: 'acc-1:msg-99',
          label: 'Quarterly Review Notes',
        },
      });
    });
  });

  it('handles attach failure with error toast', async () => {
    api.attachToThread.mockRejectedValue(new Error('Network error'));
    render(<AddToThreadButton threadRef={sampleRef} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Brain thread' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);

    await waitFor(() => {
      expect(screen.getByText('Sprint planning')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Sprint planning'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Network error');
    });
  });

  it('closes popover on Close button click', async () => {
    render(<AddToThreadButton threadRef={sampleRef} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Brain thread' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

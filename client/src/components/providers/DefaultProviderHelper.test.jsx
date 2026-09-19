import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DefaultProviderHelper from './DefaultProviderHelper';

describe('DefaultProviderHelper', () => {
  it('renders a fallback when no default provider is set', () => {
    render(<DefaultProviderHelper provider={null} />);
    expect(screen.getByText('No default provider configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jump to card/ })).toBeNull();
  });

  it('renders provider name, harness, model, and effort when fully configured', () => {
    const onScrollToCard = vi.fn();
    const provider = {
      id: 'opencode-cli',
      name: 'OpenCode CLI',
      type: 'cli',
      command: 'opencode',
      defaultModel: 'stealth/ox-alpha',
      effort: 'high',
    };

    render(<DefaultProviderHelper provider={provider} onScrollToCard={onScrollToCard} />);

    expect(screen.getByTestId('default-helper-provider-name')).toHaveTextContent('OpenCode CLI');
    expect(screen.getByTestId('default-helper-provider-name')).toHaveTextContent('(OpenCode)');
    expect(screen.getByTestId('default-helper-model')).toHaveTextContent('stealth/ox-alpha');
    expect(screen.getByTestId('default-helper-effort')).toHaveTextContent('high');

    const jumpButton = screen.getByRole('button', { name: /Jump to card/ });
    expect(jumpButton).toBeInTheDocument();
    fireEvent.click(jumpButton);
    expect(onScrollToCard).toHaveBeenCalledTimes(1);
  });

  it('renders "None" for model and effort when omitted', () => {
    const provider = {
      id: 'lmstudio',
      name: 'LM Studio',
      type: 'api',
      endpoint: 'http://localhost:1234/v1',
    };

    render(<DefaultProviderHelper provider={provider} />);

    expect(screen.getByTestId('default-helper-provider-name')).toHaveTextContent('LM Studio');
    expect(screen.getByTestId('default-helper-provider-name')).toHaveTextContent('(Direct API)');
    expect(screen.getByTestId('default-helper-model')).toHaveTextContent('None');
    expect(screen.getByTestId('default-helper-effort')).toHaveTextContent('None');
  });
});

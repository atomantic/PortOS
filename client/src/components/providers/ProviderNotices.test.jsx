import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GatewayKeyHint } from './ProviderNotices';

const gateway = { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' };

describe('GatewayKeyHint', () => {
  it('collapses to a status line plus the edit link once the key is configured', () => {
    // The three paragraphs explaining WHERE to put the key answer a question a
    // configured user no longer has — they read as an unfinished setup step.
    const onEdit = vi.fn();
    const sibling = { id: 'openrouter', name: 'OpenRouter', hasApiKey: true };
    render(<GatewayKeyHint gateway={gateway} sibling={sibling} onEdit={onEdit} />);

    expect(screen.getByText('OpenRouter API key configured')).toBeTruthy();
    expect(screen.queryByText(/no key field of its own/)).toBeNull();
    expect(screen.queryByText(/OPENROUTER_API_KEY/)).toBeNull();

    // The link survives the collapse — changing the key stays one click away.
    fireEvent.click(screen.getByRole('button', { name: 'Edit OpenRouter API provider' }));
    expect(onEdit).toHaveBeenCalledWith(sibling);
  });

  it('keeps the full explanation while the key is missing', () => {
    render(<GatewayKeyHint gateway={gateway} sibling={{ id: 'openrouter', hasApiKey: false }} onEdit={vi.fn()} />);

    expect(screen.getByText('OpenRouter key: not set')).toBeTruthy();
    expect(screen.getByText(/no key field of its own/)).toBeTruthy();
    expect(screen.getByText('OPENROUTER_API_KEY')).toBeTruthy();
  });

  it('links to the vendor key page while the gateway key is missing', () => {
    const nim = { id: 'nvidia-nim', label: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', keyUrl: 'https://build.nvidia.com' };
    render(<GatewayKeyHint gateway={nim} sibling={{ id: 'nvidia-nim', hasApiKey: false }} onEdit={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Get a NVIDIA NIM key' })).toHaveAttribute('href', 'https://build.nvidia.com');
  });

  it('shows no key link for a gateway with no vendor key page', () => {
    render(<GatewayKeyHint gateway={gateway} sibling={{ id: 'openrouter', hasApiKey: false }} onEdit={vi.fn()} />);

    expect(screen.queryByRole('link', { name: /Get a .* key/ })).toBeNull();
  });

  it('renders nothing for a provider that fronts no gateway', () => {
    const { container } = render(<GatewayKeyHint gateway={null} sibling={null} />);
    expect(container.textContent).toBe('');
  });
});

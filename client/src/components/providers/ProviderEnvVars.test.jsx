import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProviderEnvVars from './ProviderEnvVars';
import * as clipboard from '../../lib/clipboard';

vi.mock('../../lib/clipboard', () => ({
  copyToClipboard: vi.fn(),
}));

describe('ProviderEnvVars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when envVars is null, empty, or not an object', () => {
    const { container: c1 } = render(<ProviderEnvVars envVars={null} />);
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(<ProviderEnvVars envVars={{}} />);
    expect(c2.firstChild).toBeNull();
  });

  it('renders short plain values inline without expand button', () => {
    render(
      <ProviderEnvVars
        envVars={{ FOO: 'bar', BAZ: '123' }}
      />
    );

    expect(screen.getByText('Env:')).toBeInTheDocument();
    expect(screen.getByText('FOO=bar')).toBeInTheDocument();
    expect(screen.getByText('BAZ=123')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
  });

  it('masks secret env vars and does not offer expand, copy, or leak full value', () => {
    render(
      <ProviderEnvVars
        envVars={{
          API_KEY: 'sk-super-secret-123456789012345678901234567890123456789012345678901234567890',
          EMPTY_KEY: '',
        }}
        secretEnvVars={['API_KEY', 'EMPTY_KEY']}
      />
    );

    expect(screen.getByText('API_KEY=***')).toBeInTheDocument();
    expect(screen.getByText('EMPTY_KEY=(not set)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    expect(screen.queryByText(/sk-super-secret/)).toBeNull();
  });

  it('truncates long plain values with an expand/collapse toggle', () => {
    const longValue = 'a'.repeat(150);
    render(
      <ProviderEnvVars
        envVars={{ LONG_VAR: longValue }}
      />
    );

    const expandBtn = screen.getByRole('button', { name: /expand long_var value/i });
    expect(expandBtn).toBeInTheDocument();
    expect(expandBtn).toHaveAttribute('aria-expanded', 'false');

    // Initially collapsed: text contains truncated preview with ellipsis
    expect(screen.getByText(new RegExp(`${'a'.repeat(96)}…`))).toBeInTheDocument();
    expect(screen.queryByText(longValue)).toBeNull();

    // Click expand
    fireEvent.click(expandBtn);
    expect(expandBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /collapse long_var value/i })).toBeInTheDocument();

    // Full value visible in expanded pre block
    const pre = screen.getByText(longValue);
    expect(pre.tagName.toLowerCase()).toBe('pre');
    expect(pre.className).toContain('break-all');

    // Click collapse
    fireEvent.click(screen.getByRole('button', { name: /collapse long_var value/i }));
    expect(screen.queryByText(longValue)).toBeNull();
  });

  it('handles JSON values by showing compact preview when collapsed and formatted JSON when expanded', () => {
    const jsonObj = {
      permission: 'allow',
      provider: {
        'nvidia-nim': {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://localhost:8000/v1',
          },
        },
      },
    };
    const jsonStr = JSON.stringify(jsonObj);

    render(
      <ProviderEnvVars
        envVars={{ OPENCODE_CONFIG_CONTENT: jsonStr }}
      />
    );

    // Expand button is present
    const expandBtn = screen.getByRole('button', { name: /expand opencode_config_content value/i });
    expect(expandBtn).toBeInTheDocument();

    // Expand to see formatted JSON
    fireEvent.click(expandBtn);
    const pre = screen.getByRole('button', { name: /collapse/i }).closest('.min-w-0').querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre.textContent).toBe(JSON.stringify(jsonObj, null, 2));
  });

  it('copies full unmasked value on copy button click', () => {
    const longVal = 'xyz_'.repeat(30);
    render(
      <ProviderEnvVars
        envVars={{ LONG_TEXT: longVal }}
      />
    );

    // Expand first
    fireEvent.click(screen.getByRole('button', { name: /expand long_text value/i }));

    const copyBtn = screen.getByRole('button', { name: /copy long_text value/i });
    expect(copyBtn).toBeInTheDocument();

    fireEvent.click(copyBtn);
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(longVal, 'LONG_TEXT copied');
  });

  it('includes overflow containment and break-all classes to prevent card blowout', () => {
    const { container } = render(
      <ProviderEnvVars
        envVars={{ TEST: 'some_val' }}
      />
    );

    const root = container.firstChild;
    expect(root.className).toContain('overflow-hidden');
    expect(root.className).toContain('min-w-0');
    expect(root.className).toContain('max-w-full');

    const code = screen.getByText(/TEST=some_val/);
    expect(code.className).toContain('break-all');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PromptGuardHfAccessNotice from './PromptGuardHfAccessNotice';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));

const MODEL = {
  name: 'Llama Prompt Guard 2 86M',
  sourceUrl: 'https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M',
};

describe('PromptGuardHfAccessNotice', () => {
  it('does not guess that a token is absent while the status check is pending', () => {
    render(<PromptGuardHfAccessNotice tokenPresent={null} model={MODEL} />);

    expect(screen.getByTestId('prompt-guard-hf-checking')).toHaveTextContent('Checking Hugging Face token status');
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();
  });

  it('reuses the token-entry banner and explicitly links to the usage request', () => {
    render(<PromptGuardHfAccessNotice tokenPresent={false} tokenSource="none" model={MODEL} />);

    expect(screen.getByTestId('prompt-guard-hf-token-entry')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('hf_…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open model card and submit usage request/i })).toHaveAttribute(
      'href',
      MODEL.sourceUrl,
    );
  });

  it('shows the access-request branch without asking for a second token', () => {
    render(<PromptGuardHfAccessNotice tokenPresent model={MODEL} tokenSource="stored" />);

    expect(screen.getByTestId('prompt-guard-hf-access')).toHaveTextContent('token configured (stored in settings)');
    expect(screen.getByRole('link', { name: /submit usage request/i })).toHaveAttribute('href', MODEL.sourceUrl);
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();
  });

  it('keeps the replacement-token escape hatch', () => {
    render(<PromptGuardHfAccessNotice tokenPresent model={MODEL} tokenSource="env" />);

    fireEvent.click(screen.getByRole('button', { name: /use a different token/i }));
    expect(screen.getByPlaceholderText('hf_…')).toBeInTheDocument();
  });
});

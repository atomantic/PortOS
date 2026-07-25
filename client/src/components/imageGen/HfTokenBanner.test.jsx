import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HfTokenBanner from './HfTokenBanner';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));

describe('HfTokenBanner', () => {
  it('uses the same guidance and model list for one gated model', () => {
    render(
      <HfTokenBanner
        modelLabel="MuScriptor"
        licenseUrl="https://huggingface.co/MuScriptor/muscriptor-medium"
      />,
    );

    expect(screen.getByText(/needs a free Hugging Face account/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /MuScriptor/i })).toHaveAttribute(
      'href',
      'https://huggingface.co/MuScriptor/muscriptor-medium',
    );
    expect(screen.queryByText(/MuScriptor is a gated model/i)).toBeNull();
  });

  it('renders every supplied gated-model link through that same list', () => {
    render(
      <HfTokenBanner
        models={[
          { label: 'First model', url: 'https://huggingface.co/first' },
          { label: 'Second model', url: 'https://huggingface.co/second' },
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: /First model/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Second model/i })).toBeTruthy();
  });
});

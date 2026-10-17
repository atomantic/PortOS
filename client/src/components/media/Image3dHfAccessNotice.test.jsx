/**
 * The gated-Hugging-Face prerequisite notice, tested directly.
 *
 * It has two hosts (the `/3d` render flow and Models → 3D), so asserting its
 * contract only through them means a change to the component fails suites named
 * after other things — and either host could drop its cases without anyone
 * noticing the component lost coverage.
 *
 * The contract that matters is TRI-STATE `tokenPresent`: `null` means "status
 * still loading", NOT "absent". Collapsing those flashes "go add a token" at a
 * user who already has one.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../services/api', () => ({}));

import Image3dHfAccessNotice from './Image3dHfAccessNotice';

const MODELS = [{ label: 'briaai/RMBG-2.0', url: 'https://huggingface.co/briaai/RMBG-2.0' }];

const renderNotice = (props) => render(
  <Image3dHfAccessNotice models={MODELS} tokenPresent={false} tokenSource="none" {...props} />,
);

describe('Image3dHfAccessNotice', () => {
  it('renders nothing when no gated repos apply', () => {
    const { container } = renderNotice({ models: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while token status is still unknown', () => {
    // `null` is "not fetched yet", not "no token" — the difference between a
    // silent panel and a false alarm.
    const { container } = renderNotice({ tokenPresent: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the paste-and-save banner when no token is configured', () => {
    renderNotice({ tokenPresent: false });
    expect(screen.getByPlaceholderText('hf_…')).toBeInTheDocument();
  });

  it('confirms a configured token, names its source, and still lists the gated repos', () => {
    // A token does NOT grant access until the repo terms are accepted, so the
    // list has to survive the "you're all set" state.
    renderNotice({ tokenPresent: true, tokenSource: 'stored' });
    expect(screen.getByText(/Hugging Face token configured/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /briaai\/RMBG-2\.0/ })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();
  });

  it('reopens the paste form for a token that is present but rejected', () => {
    // The runner's auth-failure guidance says to add a token on this page, so a
    // stale/invalid token must not lock the form away behind "already configured".
    renderNotice({ tokenPresent: true, tokenSource: 'stored' });
    fireEvent.click(screen.getByRole('button', { name: /use a different token/i }));
    expect(screen.getByPlaceholderText('hf_…')).toBeInTheDocument();
  });
});

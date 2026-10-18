import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * The render-lane picker shared by the walk panel and every track panel (#4876).
 *
 * The behaviors that matter are all about NOT misleading the user: it must stay
 * invisible until the server's readiness list arrives (so a slow probe does not
 * flash a control that then vanishes), it must not imply a choice on an install
 * that has only one lane, and an unusable lane must stay visible-but-blocked with
 * the reason spelled out as text rather than hidden in a title attribute.
 */

import AnimationProviderPicker from './AnimationProviderPicker.jsx';

const GROK = { id: 'grok', label: 'Grok (cloud)', ready: true, reason: null };
const LOCAL_READY = { id: 'local', label: 'Local (MiniMax H3)', ready: true, reason: null };
const LOCAL_BLOCKED = {
  id: 'local',
  label: 'Local (MiniMax H3)',
  ready: false,
  reason: 'The MiniMax H3 MLX runtime is not installed — install it from Video Gen, then reload.',
};

const renderPicker = (props = {}) => render(
  <AnimationProviderPicker
    id="walk-provider-hero"
    providers={[GROK, LOCAL_READY]}
    provider="grok"
    onChange={vi.fn()}
    {...props}
  />,
);

describe('AnimationProviderPicker', () => {
  it('renders nothing while the readiness list has not arrived', () => {
    const { container } = renderPicker({ providers: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when this install offers only one lane', () => {
    // A single-option dropdown implies a choice the user does not have.
    const { container } = renderPicker({ providers: [GROK] });
    expect(container).toBeEmptyDOMElement();
    expect(renderPicker({ providers: [] }).container).toBeEmptyDOMElement();
  });

  it('lists both lanes and pairs its label to the select by id', () => {
    renderPicker();
    const select = screen.getByLabelText(/Render on/);
    expect(select).toHaveAttribute('id', 'walk-provider-hero');
    expect(select.value).toBe('grok');
    expect(screen.getByRole('option', { name: 'Grok (cloud)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Local (MiniMax H3)' })).toBeInTheDocument();
  });

  it('reports the chosen lane by id', () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    fireEvent.change(screen.getByLabelText(/Render on/), { target: { value: 'local' } });
    expect(onChange).toHaveBeenCalledWith('local');
  });

  it('disables an unready lane and marks it in the option text', () => {
    renderPicker({ providers: [GROK, LOCAL_BLOCKED] });
    const option = screen.getByRole('option', { name: /Local \(MiniMax H3\) \(unavailable\)/ });
    expect(option).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Grok (cloud)' })).not.toBeDisabled();
  });

  it('shows the blocking reason as TEXT while another lane is selected', () => {
    // The reachable case, and the one that matters: an unready lane is a
    // DISABLED option, so it can never be the selection. Gating the reason on
    // being selected made it dead code, and the reason is the only place the one
    // thing to fix is named. Not a `title` either — per the repo's UI rules a
    // tooltip-only warning is missed on touch.
    renderPicker({ providers: [GROK, LOCAL_BLOCKED], provider: 'grok' });
    expect(screen.getByText(/runtime is not installed/)).toBeInTheDocument();
  });

  it('says nothing when every lane is ready', () => {
    renderPicker({ providers: [GROK, LOCAL_READY], provider: 'grok' });
    expect(screen.queryByText(/runtime is not installed/)).toBeNull();
    expect(screen.queryByText(/not downloaded/)).toBeNull();
  });

  it('names EACH unready lane rather than only the first', () => {
    const other = { id: 'other', label: 'Other', ready: false, reason: 'Other lane is not downloaded.' };
    renderPicker({ providers: [GROK, LOCAL_BLOCKED, other], provider: 'grok' });
    expect(screen.getByText(/runtime is not installed/)).toBeInTheDocument();
    expect(screen.getByText(/Other lane is not downloaded/)).toBeInTheDocument();
  });

  it('disables the whole control when the caller says the set is frozen', () => {
    renderPicker({ disabled: true });
    expect(screen.getByLabelText(/Render on/)).toBeDisabled();
  });

  it('renders ListLoadError when error is present', () => {
    const onRetry = vi.fn();
    renderPicker({ error: new Error('Failed to load providers'), onRetry });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load animation providers — Failed to load providers');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

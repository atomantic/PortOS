import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('./ChannelBrainPicker', () => ({ default: () => <div>brain picker</div> }));
vi.mock('./RealtimeCallPanel', () => ({ default: () => <div>realtime panel</div> }));
vi.mock('./AvatarRuntimeSettings', () => ({ default: () => <div>avatar settings</div> }));

import { SatPhoneSetup } from './SatPhoneFaceplate';

const setDesktop = (matches) => {
  window.matchMedia = vi.fn().mockReturnValue({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() });
};
const renderSetup = () => render(<MemoryRouter><SatPhoneSetup llmProvider="ollama" llmModel="auto" /></MemoryRouter>);

afterEach(() => { window.localStorage.clear(); });

describe('SatPhoneSetup', () => {
  it('stacks every section on a phone', () => {
    setDesktop(false);
    renderSetup();
    expect(screen.queryByRole('tablist')).toBeNull();
    for (const text of ['brain picker', 'realtime panel', 'avatar settings']) expect(screen.getByText(text)).toBeVisible();
  });

  it('shows one section at a time behind tabs on desktop, keeping the others mounted', () => {
    setDesktop(true);
    renderSetup();
    expect(screen.getByText('brain picker')).toBeVisible();
    expect(screen.getByText('realtime panel')).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: /Realtime/ }));
    expect(screen.getByRole('tab', { name: /Realtime/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('realtime panel')).toBeVisible();
    expect(screen.getByText('brain picker')).not.toBeVisible();
    expect(screen.getByText('avatar settings')).toBeInTheDocument();
  });
});

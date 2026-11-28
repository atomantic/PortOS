import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('./ChannelBrainPicker', () => ({ default: () => <div>brain picker</div> }));
vi.mock('./RealtimeCallPanel', () => ({ default: () => <div>realtime panel</div> }));

import { SatPhoneSetup } from './SatPhoneFaceplate';

const setDesktop = (matches) => {
  window.matchMedia = vi.fn().mockReturnValue({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() });
};
const renderSetup = () => render(<SatPhoneSetup llmProvider="ollama" llmModel="auto" />);

afterEach(() => { window.localStorage.clear(); });

describe('SatPhoneSetup', () => {
  it('stacks every section on a phone', () => {
    setDesktop(false);
    renderSetup();
    expect(screen.queryByRole('tablist')).toBeNull();
    for (const text of ['brain picker', 'realtime panel']) expect(screen.getByText(text)).toBeVisible();
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
    expect(screen.queryByRole('tab', { name: /Avatar/ })).toBeNull();
  });
});

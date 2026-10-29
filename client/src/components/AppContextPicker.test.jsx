import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AppContextPicker from './AppContextPicker';

const apps = [
  { id: 'live', name: 'critical-mass', archived: false },
  { id: 'old', name: 'Critical Mass', archived: true },
];

const optionNames = () => screen.getAllByRole('option').map(o => o.textContent);

describe('AppContextPicker', () => {
  afterEach(cleanup);

  it('hides archived apps so they do not duplicate the live app', () => {
    render(<AppContextPicker apps={apps} value="" showRepoPath={false} />);
    expect(optionNames()).toEqual(['PortOS (default)', 'critical-mass']);
  });

  it('keeps an archived app that is the current selection', () => {
    render(<AppContextPicker apps={apps} value="old" showRepoPath={false} />);
    expect(optionNames()).toContain('Critical Mass');
  });
});

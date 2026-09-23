import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AppIcon from './AppIcon';

describe('AppIcon', () => {
  it('uses the app name as the custom image alt text', () => {
    render(<AppIcon appId="example-app" appName="Example App" hasAppIcon />);

    const image = screen.getByRole('img', { name: 'Example App' });
    expect(image.getAttribute('alt')).toBe('Example App');
  });

  it('prefers an explicit aria label over the app name', () => {
    render(<AppIcon appId="example-app" appName="Example App" ariaLabel="Example app icon" hasAppIcon />);

    const image = screen.getByRole('img', { name: 'Example app icon' });
    expect(image.getAttribute('alt')).toBe('Example app icon');
  });

  it('provides a non-empty default alt when no app name is available', () => {
    render(<AppIcon appId="example-app" hasAppIcon />);

    expect(screen.getByRole('img', { name: 'Application icon' }).getAttribute('alt')).toBe('Application icon');
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ThemeSwitcher from './ThemeSwitcher';

vi.mock('./ThemeContext', async () => {
  const { THEME_LIST } = await import('../themes/portosThemes');
  return {
    useThemeContext: () => ({
      themeId: 'classic-midnight',
      theme: { label: 'Classic Midnight' },
      themeList: THEME_LIST,
      setTheme: vi.fn(),
    }),
  };
});

describe('ThemeSwitcher', () => {
  it('exposes the current theme in the full, height-constrained keyboard menu', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /Switch theme/ }));

    const menu = screen.getByRole('menu', { name: 'Interface theme' });
    const items = within(menu).getAllByRole('menuitemradio');
    const active = items[0];
    const next = items[1];
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(menu).toHaveStyle({ visibility: 'visible' });
    expect(menu.className).toContain('overflow-y-auto');
    expect(menu.style.maxHeight).toMatch(/^\d+px$/);
    expect(active).toHaveAttribute('aria-checked', 'true');
    expect(next).toHaveAttribute('aria-checked', 'false');
    expect(active).toHaveFocus();

    fireEvent.keyDown(active, { key: 'ArrowDown' });
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: 'ArrowUp' });
    expect(active).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch theme/ })).toHaveFocus();
  });

  it('keeps 44px mobile touch target while compact on desktop', () => {
    render(<ThemeSwitcher />);
    const button = screen.getByRole('button', { name: /Switch theme/ });
    expect(button.className).toContain('min-w-[44px]');
    expect(button.className).toContain('min-h-[44px]');
    expect(button.className).toContain('lg:min-w-0');
    expect(button.className).toContain('lg:min-h-0');
  });
});

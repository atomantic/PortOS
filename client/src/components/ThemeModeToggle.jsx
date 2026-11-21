import { Moon, Sun } from 'lucide-react';
import { useThemeContext } from './ThemeContext';

export default function ThemeModeToggle({ className = '' }) {
  const { theme, toggleMode } = useThemeContext();
  const isDay = theme?.mode === 'day';
  const Icon = isDay ? Sun : Moon;
  const pairLabel = theme?.pair ? ` (${isDay ? 'switch to night' : 'switch to day'})` : '';
  return (
    <button
      type="button"
      onClick={toggleMode}
      title={`${theme?.label ?? 'Theme'}${pairLabel}`}
      aria-label={`Toggle day/night mode${pairLabel}`}
      className={`inline-flex items-center justify-center min-w-[44px] min-h-[44px] pointer-fine:lg:min-w-0 pointer-fine:lg:min-h-0 lg:p-1.5 rounded-lg text-gray-500 hover:text-port-accent transition-colors ${className}`}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}

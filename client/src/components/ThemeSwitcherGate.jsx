import { Suspense, useState } from 'react';
import { Palette } from 'lucide-react';
import { useThemeContext } from './ThemeContext';
import { lazyWithReload } from '../utils/lazyWithReload';

// Keep ThemeSwitcher (menu portal, family icons, keyboard roving focus) out
// of the cold-load bundle until the user opens the theme menu. `entryClosure.test.js`
// guards this boundary.
const LazyThemeSwitcher = lazyWithReload(() => import('./ThemeSwitcher'));

export default function ThemeSwitcherGate({ position = 'above', className = '' }) {
  const { theme } = useThemeContext();
  const [activated, setActivated] = useState(false);

  const trigger = (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setActivated(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActivated(true);
          }
        }}
        className="min-h-[44px] min-w-[44px] pointer-fine:lg:min-h-0 pointer-fine:lg:min-w-0 inline-flex items-center justify-center p-1.5 rounded-lg text-gray-500 hover:text-port-accent transition-colors"
        title="Switch theme"
        aria-label={`Switch theme. Current theme: ${theme?.label ?? 'Classic Midnight'}`}
        aria-haspopup="menu"
        aria-expanded={false}
      >
        <Palette size={18} />
      </button>
    </div>
  );

  if (!activated) return trigger;

  return (
    <Suspense fallback={trigger}>
      <LazyThemeSwitcher position={position} className={className} initialOpen />
    </Suspense>
  );
}

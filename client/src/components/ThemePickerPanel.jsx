import { Check } from 'lucide-react';
import { useThemeContext } from './ThemeContext';
import { getFamilyIcon } from '../themes/familyIcons';

export default function ThemePickerPanel({ compact = false }) {
  const { themeId, themeList, setTheme } = useThemeContext();

  return (
    <div className={compact ? 'grid gap-2' : 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4'}>
      {themeList.map(theme => {
        const Icon = getFamilyIcon(theme.family);
        const active = theme.id === themeId;
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => setTheme(theme.id)}
            aria-pressed={active}
            className={`group text-left border transition-colors ${
              compact ? 'rounded-lg p-3' : 'rounded-xl p-4'
            } ${
              active
                ? 'bg-port-accent/10 border-port-accent/60 text-white'
                : 'bg-port-card border-port-border text-gray-300 hover:text-white hover:border-port-accent/50'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-port-bg border border-port-border text-port-accent shrink-0">
                  <Icon size={16} />
                </span>
                <div className="min-w-0">
                  <div className="font-semibold truncate">{theme.label}</div>
                  <div className="text-xs text-gray-500 capitalize">{theme.density}</div>
                </div>
              </div>
              {active && (
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-port-accent text-white shrink-0">
                  <Check size={13} />
                </span>
              )}
            </div>

            {!compact && (
              <p className="mt-3 text-sm text-gray-400 line-clamp-3 min-h-[60px]">
                {theme.concept}
              </p>
            )}

            <div className="mt-3 flex items-center gap-1.5">
              {theme.swatches.map(color => (
                <span
                  key={color}
                  className="h-4 flex-1 rounded border border-white/15"
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </button>
        );
      })}
    </div>
  );
}

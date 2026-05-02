import { Sun, Moon } from 'lucide-react';
import { useThemeContext } from './ThemeContext';
import { getFamilyIcon } from '../themes/familyIcons';
import { groupThemesByFamily } from '../themes/portosThemes';

const FAMILIES = groupThemesByFamily();

export default function ThemePickerPanel({ compact = false }) {
  const { themeId, setTheme } = useThemeContext();

  return (
    <div className={compact ? 'grid gap-2' : 'grid gap-3 sm:grid-cols-2 xl:grid-cols-2'}>
      {FAMILIES.map(group => {
        const Icon = getFamilyIcon(group.family);
        const activeMode = themeId === group.day?.id ? 'day' : themeId === group.night?.id ? 'night' : null;
        const displayed = activeMode === 'day' ? group.day : group.night ?? group.day;
        const cardActive = activeMode !== null;
        return (
          <div
            key={group.family}
            className={`text-left border transition-colors ${compact ? 'rounded-lg p-3' : 'rounded-xl p-4'} ${
              cardActive
                ? 'bg-port-accent/10 border-port-accent/60'
                : 'bg-port-card border-port-border'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => setTheme(displayed.id)}
                aria-pressed={cardActive}
                className="flex items-center gap-2 min-w-0 flex-1 text-left group"
              >
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-port-bg border border-port-border text-port-accent shrink-0">
                  <Icon size={16} />
                </span>
                <div className="min-w-0">
                  <div className="font-semibold truncate group-hover:text-port-accent transition-colors">
                    {displayed.label}
                  </div>
                  <div className="text-xs text-port-text-muted capitalize">{displayed.density}</div>
                </div>
              </button>

              <ModeSwitch group={group} activeMode={activeMode} onPick={setTheme} />
            </div>

            {!compact && (
              <p className="mt-3 text-sm text-port-text-muted line-clamp-3 min-h-[60px]">
                {displayed.concept}
              </p>
            )}

            <div className="mt-3 flex items-center gap-1.5">
              {displayed.swatches.map(color => (
                <span
                  key={color}
                  className="h-4 flex-1 rounded border border-white/15"
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ModeSwitch({ group, activeMode, onPick }) {
  const has = (mode) => Boolean(group[mode]);
  // Buttons are 40x40 minimum so the seam in the middle of the pill is still
  // a comfortable mobile tap target. >=sm collapses to the original compact pill.
  const buttonClass = 'inline-flex items-center justify-center rounded-full transition-colors min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 sm:p-1.5';
  return (
    <div
      role="group"
      aria-label="Day/night mode"
      className="inline-flex items-center bg-port-bg border border-port-border rounded-full p-0.5 shrink-0"
    >
      <button
        type="button"
        onClick={() => has('night') && onPick(group.night.id)}
        aria-label={`Use ${group.night?.label ?? 'night'} mode`}
        aria-pressed={activeMode === 'night'}
        disabled={!has('night')}
        className={`${buttonClass} ${
          activeMode === 'night'
            ? 'bg-port-accent text-port-on-accent'
            : 'text-port-text-muted hover:text-port-text disabled:opacity-40'
        }`}
      >
        <Moon size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => has('day') && onPick(group.day.id)}
        aria-label={`Use ${group.day?.label ?? 'day'} mode`}
        aria-pressed={activeMode === 'day'}
        disabled={!has('day')}
        className={`${buttonClass} ${
          activeMode === 'day'
            ? 'bg-port-accent text-port-on-accent'
            : 'text-port-text-muted hover:text-port-text disabled:opacity-40'
        }`}
      >
        <Sun size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, ShieldOff, X } from 'lucide-react';
import { anchorUserExclude, anchorUserExcludes } from '../../lib/backupExcludes';
import ToggleSwitch from '../ToggleSwitch';
import CollapsibleSection from '../ui/CollapsibleSection';

export default function BackupExclusionsSection({
  sectionRef, unavailable, defaultExcludes, excludePaths, disabledDefaultExcludes,
  disclosure, toggleDisclosure, toggleDefaultExclude, setExcludePaths,
}) {
  const additionalExcludeId = useId();
  const defaultExcludesPanelId = useId();
  const effectiveExcludesPanelId = useId();
  const exclusionsPanelId = useId();
  const [newExclude, setNewExclude] = useState('');

  // Anchor exactly as the server does on read, so the chip the user sees IS the
  // rsync filter that will run. A bare `repos/` would otherwise match every
  // `repos/` at any depth under data/ and silently drop unrelated records (#7241).
  const addExclude = () => {
    const anchored = anchorUserExclude(newExclude);
    if (!anchored) return;
    if (!excludePaths.includes(anchored)) setExcludePaths([...excludePaths, anchored]);
    setNewExclude('');
  };

  const removeExclude = (index) => {
    setExcludePaths(excludePaths.filter((_, i) => i !== index));
  };

  const defaultExcludeRows = defaultExcludes.map(d => ({
    ...d,
    defaultActive: !(d.overridable && disabledDefaultExcludes.includes(d.path)),
  }));
  const enabledDefaultCount = defaultExcludeRows.filter(d => d.defaultActive).length;
  const disabledDefaultCount = defaultExcludeRows.length - enabledDefaultCount;

  // The rsync filter list this configuration actually produces — the client half
  // of `computeEffectiveExcludes`, built from the same anchoring helper so the
  // preview cannot drift from the run. Rendering it is the point: without it the
  // user never sees how a pattern was interpreted until a restore comes up short.
  const effectiveExcludes = [...new Set([
    ...defaultExcludeRows.filter(d => d.defaultActive).map(d => d.path),
    ...anchorUserExcludes(excludePaths),
  ])];
  const exclusionsSummary = unavailable
    ? 'Unavailable — reload to retry'
    : excludePaths.length > 0
    ? `${excludePaths.length} custom · ${effectiveExcludes.length} active patterns`
    : `${effectiveExcludes.length} active patterns`;

  return (
    <div ref={sectionRef} className="scroll-mt-20 border-t border-port-border pt-5">
      <CollapsibleSection
        label="Exclusions"
        icon={ShieldOff}
        summary={exclusionsSummary}
        id={exclusionsPanelId}
        open={!!disclosure.exclusions}
        onOpenChange={(next) => toggleDisclosure('exclusions', next)}
        size="bar"
        className="space-y-3"
        bodyClassName="space-y-4 pt-2"
      >
        {unavailable ? (
          <p className="text-sm text-port-warning">Backup exclusion details are unavailable — reload to retry before editing these rules.</p>
        ) : (
          <>
            <p className="text-sm text-gray-400">Review default and custom rules that keep data out of snapshots. Optional defaults can be disabled; always-excluded rules cannot. Custom rules still apply independently.</p>

            {defaultExcludeRows.length > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => toggleDisclosure('defaultExcludes', !disclosure.defaultExcludes)}
                  aria-expanded={!!disclosure.defaultExcludes}
                  aria-controls={disclosure.defaultExcludes ? defaultExcludesPanelId : undefined}
                  className="flex items-center gap-2 w-full text-left text-sm text-gray-400 hover:text-white transition-colors min-h-[44px]"
                >
                  {disclosure.defaultExcludes ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                  <ShieldOff size={14} className="text-gray-500 shrink-0" />
                  <span>Default exclusions — {enabledDefaultCount} enabled, {disabledDefaultCount} disabled</span>
                </button>
                {disclosure.defaultExcludes && (
                  <div id={defaultExcludesPanelId} className="space-y-2">
                    <p className="text-xs text-gray-500">Built-in exclusion rules keep snapshots small. Switch on to disable an overridable default rule; fixed rules remain enabled.</p>
                    <ul className="space-y-1.5 mt-1">
                      {defaultExcludeRows.map((d, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          {d.overridable ? (
                            <ToggleSwitch
                              enabled={!d.defaultActive}
                              onChange={() => toggleDefaultExclude(d.path)}
                              size="sm"
                              ariaLabel={`Disable default exclusion ${d.path}`}
                              className="mt-0.5"
                            />
                          ) : (
                            <span className="inline-flex items-center justify-center w-12 h-7 shrink-0 text-gray-600" title="Fixed default exclusion — always enabled">
                              <ShieldOff size={14} />
                            </span>
                          )}
                          <code className="px-1.5 py-0.5 bg-port-bg border rounded shrink-0 text-gray-300 border-port-border">{d.path}</code>
                          <span className="text-gray-500">
                            <span className="text-gray-400">{d.overridable ? 'Optional' : 'Always excluded'} · </span>{d.reason}
                            {!d.defaultActive && <span className="text-gray-400 ml-1">(Default exclusion disabled)</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor={additionalExcludeId} className="block text-sm text-gray-400">Additional Exclude Paths</label>
              <p className="text-xs text-gray-500">Custom directories/patterns to skip during backup (relative to data/). Patterns are anchored to the data root, so <code>repos/</code> is stored as <code>/repos/</code> and skips only <code>data/repos/</code>. Start a pattern with <code>**/</code> to match at any depth instead. Additional rules still apply when a default exclusion is disabled. Disabling a default does not guarantee matching files will be backed up.</p>
              <div className="flex flex-wrap gap-2">
                <input
                  id={additionalExcludeId}
                  type="text"
                  value={newExclude}
                  onChange={e => setNewExclude(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addExclude()}
                  className="flex-1 min-w-[12rem] bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                  placeholder="/repos/"
                />
                <button
                  type="button"
                  onClick={addExclude}
                  disabled={!anchorUserExclude(newExclude)}
                  aria-label="Add exclude path"
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center justify-center min-w-[40px] min-h-[40px] px-3 py-2 bg-port-border hover:bg-port-border/70 text-white rounded-lg transition-colors disabled:opacity-50 shrink-0"
                >
                  <Plus size={16} />
                </button>
              </div>
              {excludePaths.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {excludePaths.map((path, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-port-bg border border-port-border rounded-lg text-sm text-gray-300">
                      <code className="text-xs break-all">{path}</code>
                      <button type="button" onClick={() => removeExclude(i)} aria-label={`Remove exclude path ${path}`} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-port-error transition-colors">
                        <X size={14} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {effectiveExcludes.length > 0 && (
                <div className="space-y-2 pt-1">
                  <button
                    type="button"
                    onClick={() => toggleDisclosure('effectiveExcludes', !disclosure.effectiveExcludes)}
                    aria-expanded={!!disclosure.effectiveExcludes}
                    aria-controls={disclosure.effectiveExcludes ? effectiveExcludesPanelId : undefined}
                    className="flex items-center gap-2 w-full text-left text-sm text-gray-400 hover:text-white transition-colors min-h-[44px]"
                  >
                    {disclosure.effectiveExcludes ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                    <span>Effective exclude list — {effectiveExcludes.length} rsync {effectiveExcludes.length === 1 ? 'pattern' : 'patterns'}</span>
                  </button>
                  {disclosure.effectiveExcludes && (
                    <div id={effectiveExcludesPanelId} className="space-y-2">
                      <p className="text-xs text-gray-500">The exact <code>--exclude</code> filters the next snapshot will use: enabled default rules plus your anchored patterns. Saved changes above are reflected here.</p>
                      <ul className="flex flex-wrap gap-1.5">
                        {effectiveExcludes.map((pattern) => (
                          <li key={pattern}>
                            <code className="inline-block px-1.5 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-300 break-all">{pattern}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </CollapsibleSection>
    </div>
  );
}

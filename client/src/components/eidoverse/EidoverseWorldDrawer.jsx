import { useState } from 'react';
import { Compass, Database, Globe2, Palette, RefreshCw, Zap } from 'lucide-react';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import EidoverseFoundationsPanel from './EidoverseFoundationsPanel';
import EidoverseControllersPanel from './EidoverseControllersPanel';
import { primaryButton, secondaryButton } from './worldDrawerFields';
import useNumericFieldDraft from './useNumericFieldDraft';
import WorldIdentityFields from './WorldIdentityFields';
import WorldDistrictFields from './WorldDistrictFields';
import WorldAppearanceFields from './WorldAppearanceFields';
import WorldUpdatesPanel from './WorldUpdatesPanel';

const TABS = [
  { id: 'experience', label: 'Experience', icon: Compass },
  { id: 'districts', label: 'Districts & Data', icon: Database },
  { id: 'appearance', label: 'Appearance & Assets', icon: Palette },
  { id: 'foundations', label: 'Foundations', icon: Globe2 },
  { id: 'controllers', label: 'Controllers', icon: Zap },
  { id: 'updates', label: 'Updates & Advanced', icon: RefreshCw },
];
const TAB_IDS = TABS.map(({ id }) => id);

export default function EidoverseWorldDrawer({
  open,
  onClose,
  worldState,
  worldName,
  setWorldName,
  humanName,
  setHumanName,
  cosId,
  recipeDraft,
  assetOverridesDraft,
  labelAliasesDraft,
  mutateLabelAlias,
  frameConnection,
  labelVisibility,
  onLabelVisibilityChange,
  appId,
  mutateRecipe,
  mutateAssetOverride,
  markDirty,
  configStatus,
  projectionStatus,
  dirty,
  onSave,
  onProject,
  onReset,
  onRefreshAssets,
}) {
  const [activeTab, setActiveTab] = useDrawerTab('eidoverseTab', 'experience', TAB_IDS);
  const [resetArmed, setResetArmed] = useState(false);
  const numeric = useNumericFieldDraft();
  const design = worldState?.design || {};
  const reconciliation = design.reconciliation || {};
  const projectionSummary = worldState?.projection?.lastSummary || {};
  const projectedIndicatorCount = Number.isFinite(projectionSummary.liveEntityCount)
    ? projectionSummary.liveEntityCount
    : null;
  const projectedIndicatorLimit = projectionSummary.maxLiveEntities
    ?? design.maxEntities
    ?? recipeDraft?.maxEntities
    ?? 48;
  const busy = configStatus === 'saving' || projectionStatus === 'running';
  const projectionActionBlocked = busy || dirty;

  const panels = {
    experience: (
        <WorldIdentityFields
          worldState={worldState}
          design={design}
          recipeDraft={recipeDraft}
          reconciliation={reconciliation}
          frameConnection={frameConnection}
          appId={appId}
          labelVisibility={labelVisibility}
          onLabelVisibilityChange={onLabelVisibilityChange}
          worldName={worldName}
          setWorldName={setWorldName}
          humanName={humanName}
          setHumanName={setHumanName}
          cosId={cosId}
          markDirty={markDirty}
          projectedIndicatorCount={projectedIndicatorCount}
          projectedIndicatorLimit={projectedIndicatorLimit}
        />
    ),
    districts: (
        <WorldDistrictFields
          worldState={worldState}
          design={design}
          recipeDraft={recipeDraft}
          projectionSummary={projectionSummary}
          projectedIndicatorCount={projectedIndicatorCount}
          projectedIndicatorLimit={projectedIndicatorLimit}
          busy={busy}
          onReset={onReset}
          mutateRecipe={mutateRecipe}
          labelAliasesDraft={labelAliasesDraft}
          mutateLabelAlias={mutateLabelAlias}
          onAssets={() => setActiveTab('appearance')}
          numeric={numeric}
        />
    ),
    appearance: (
        <WorldAppearanceFields
          recipeDraft={recipeDraft}
          mutateRecipe={mutateRecipe}
          design={design}
          assetOverridesDraft={assetOverridesDraft}
          mutateAssetOverride={mutateAssetOverride}
          dirty={dirty}
          busy={busy}
          projectionActionBlocked={projectionActionBlocked}
          onRefreshAssets={onRefreshAssets}
          numeric={numeric}
        />
    ),
    updates: (
        <WorldUpdatesPanel
          design={design}
          reconciliation={reconciliation}
          projectionActionBlocked={projectionActionBlocked}
          projectionStatus={projectionStatus}
          dirty={dirty}
          busy={busy}
          onProject={onProject}
          onRefreshAssets={onRefreshAssets}
          resetArmed={resetArmed}
          setResetArmed={setResetArmed}
          onReset={onReset}
        />
    ),
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="PortOS World Design"
      subtitle={`${design.name || 'PortOS Commons'} · recipe V${design.assetRecipeVersion || 3}`}
      size="lg"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {/* Foundations and Controllers each own their own form (recording a
          foundation, or installing a controller, is not a world-config save),
          and a nested <form> is invalid HTML — so they render beside the
          config form rather than inside it. */}
      {activeTab === 'foundations' ? <EidoverseFoundationsPanel /> : activeTab === 'controllers' ? <EidoverseControllersPanel /> : (
        <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
          {panels[activeTab] ?? panels.updates}
          {(activeTab !== 'updates' || dirty) && (
            <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center justify-end gap-3 border-t border-port-border bg-port-card/95 p-4 backdrop-blur">
              {configStatus && configStatus !== 'saving' && (
                <p className={configStatus === 'saved' ? 'mr-auto text-sm text-port-success' : 'mr-auto text-sm text-port-error'} role="status">
                  {configStatus === 'saved' ? 'Saved locally and queued for projection.' : configStatus}
                </p>
              )}
              <button type="button" className={secondaryButton} onClick={onClose}>Close</button>
              <button type="submit" className={primaryButton} disabled={configStatus === 'saving'}>
                {configStatus === 'saving' ? 'Saving…' : 'Save and project'}
              </button>
            </div>
          )}
        </form>
      )}
    </Drawer>
  );
}

import AppContextPicker from '../AppContextPicker.jsx';
import { FormField } from '../ui/FormField.jsx';
import { describeRuntimeAtlas } from './publishRuntimeContract.js';

const inputClass = 'w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-200 focus:border-port-accent focus:outline-none';
const fieldLabelClass = 'block text-xs text-gray-400 mb-1';

export function PublishBindingFields({ apps, binding, setBindingField }) {
  const {
    appId, atlasDestPath, portraitDestPath, presentationIdleDestPath, codePath, resourcePath,
  } = binding;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <AppContextPicker
        apps={apps}
        value={appId}
        onChange={(value) => setBindingField('appId', value)}
        label="Managed app"
        placeholder="— none —"
        selectClassName={inputClass}
        className="sm:col-span-2"
      />
      <FormField label="Atlas destination (repo-relative .png)" labelClassName={fieldLabelClass}>
        <input value={atlasDestPath} onChange={(e) => setBindingField('atlasDestPath', e.target.value)} placeholder="assets/sprites/hero/hero-atlas.png" className={inputClass} />
      </FormField>
      <FormField label="Selector portrait (optional .png)" labelClassName={fieldLabelClass}>
        <input value={portraitDestPath} onChange={(e) => setBindingField('portraitDestPath', e.target.value)} placeholder="assets/portraits/hero.png" className={inputClass} />
      </FormField>
      <FormField label="Picker idle strip (optional .png)" labelClassName={fieldLabelClass}>
        <input value={presentationIdleDestPath} onChange={(e) => setBindingField('presentationIdleDestPath', e.target.value)} placeholder="assets/presentation/hero-idle.png" className={inputClass} />
      </FormField>
      <FormField label="Code binding file (optional)" labelClassName={fieldLabelClass}>
        <input value={codePath} onChange={(e) => setBindingField('codePath', e.target.value)} placeholder="src/Hero.cs" className={inputClass} />
      </FormField>
      <FormField label="Resource path in code (optional)" labelClassName={fieldLabelClass} className="sm:col-span-2">
        <input value={resourcePath} onChange={(e) => setBindingField('resourcePath', e.target.value)} placeholder="res://assets/sprites/hero/hero-atlas.png" className={inputClass} />
      </FormField>
    </div>
  );
}

export function RuntimeContractEditor({
  current, trackDefinitions, savedContract, contract, parsedContract,
  setTrackCount, setContractField, fillFromAtlas, clearContract, contractError,
}) {
  const { trackInputs, cellRaw, colsRaw } = parsedContract;
  const { atlasSummary, savedContractMismatch } = describeRuntimeAtlas(trackDefinitions, current?.geometry, savedContract);
  return (
    <div className="border border-port-border rounded p-2 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-gray-300">Runtime contract (optional)</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fillFromAtlas}
            disabled={!current}
            title={current ? undefined : 'Compile the atlas first'}
            className="px-2 py-0.5 text-[11px] bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
          >
            Match current atlas
          </button>
          <button
            type="button"
            onClick={clearContract}
            disabled={trackInputs.every(({ raw }) => raw === '') && cellRaw === '' && colsRaw === ''}
            className="px-2 py-0.5 text-[11px] bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </div>
      <p className="text-[11px] text-gray-500">
        The grid a consuming app was built against. A publish whose compiled atlas disagrees is
        refused. Cell size also controls compile density: use 192px for a 2× source that the
        game draws into a 96px footprint. Leave blank to use standard density; clearing removes
        a stored contract.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
        {trackInputs.map(({ definition, raw }) => (
          <FormField
            key={definition.contractFrameCountField}
            label={`${definition.label} frames (${definition.minFrameCount}–${definition.maxFrameCount}${definition.standaloneContract ? '' : ', optional'})`}
            labelClassName={fieldLabelClass}
          >
            <input
              type="number"
              min={definition.minFrameCount}
              max={definition.maxFrameCount}
              value={raw}
              onChange={(e) => setTrackCount(definition.contractFrameCountField, e.target.value)}
              placeholder={String(definition.defaultFrameCount)}
              className={inputClass}
            />
          </FormField>
        ))}
        <FormField label="Cell size px (optional)" labelClassName={fieldLabelClass}>
          <input
            type="number"
            min={16}
            max={1024}
            value={contract.cell}
            onChange={(e) => setContractField('cell', e.target.value)}
            placeholder="96"
            className={inputClass}
          />
        </FormField>
        <FormField label="Column count (optional)" labelClassName={fieldLabelClass}>
          <input
            type="number"
            min={1}
            max={256}
            value={contract.columns}
            onChange={(e) => setContractField('columns', e.target.value)}
            placeholder="13"
            className={inputClass}
          />
        </FormField>
      </div>
      {contractError && <p role="alert" className="text-[11px] text-port-error">{contractError}</p>}
      {atlasSummary && (
        <p className="text-[11px] text-gray-500">
          Current atlas grid: <span className="text-gray-300">{atlasSummary}</span>
        </p>
      )}
      {savedContractMismatch && (
        <p className="text-[11px] text-port-warning">Saved contract vs atlas: {savedContractMismatch}</p>
      )}
    </div>
  );
}

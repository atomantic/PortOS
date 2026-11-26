import FolderPicker from '../FolderPicker';
import DraftNumber from '../ui/DraftNumber';
import { FormField } from '../ui/FormField';

export function BrowserConfigPanel({ configDraft, setConfigDraft, handleChromePathChange, handleSaveConfig }) {
  return (
    <div className="mb-6 p-4 bg-port-card border border-port-border rounded-xl">
      <h3 className="text-lg font-semibold text-white mb-4">Browser Configuration</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <DraftNumber integer min={1} value={configDraft.cdpPort} onCommit={cdpPort => setConfigDraft(d => ({ ...d, cdpPort }))}>
          {(field) => (
            <FormField label="CDP Port">
              <input type="number" className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent" {...field} />
            </FormField>
          )}
        </DraftNumber>
        <FormField label="CDP Host">
          <input
            type="text"
            value={configDraft.cdpHost}
            onChange={e => setConfigDraft(d => ({ ...d, cdpHost: e.target.value }))}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent"
          />
        </FormField>
        <DraftNumber integer min={1} value={configDraft.healthPort} onCommit={healthPort => setConfigDraft(d => ({ ...d, healthPort }))}>
          {(field) => (
            <FormField label="Health Port">
              <input type="number" className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent" {...field} />
            </FormField>
          )}
        </DraftNumber>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="headless"
            checked={configDraft.headless}
            onChange={e => setConfigDraft(d => ({ ...d, headless: e.target.checked }))}
            className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
          />
          <label htmlFor="headless" className="text-sm text-gray-400">Headless mode</label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="autoConnect"
            checked={configDraft.autoConnect}
            onChange={e => setConfigDraft(d => ({ ...d, autoConnect: e.target.checked }))}
            className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
          />
          <label htmlFor="autoConnect" className="text-sm text-gray-400">Auto-connect on startup</label>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor="chromePath" className="block text-sm text-gray-400 mb-1">
            Chrome binary path
            <span className="ml-2 text-xs text-gray-600">(leave empty to use system default)</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id="chromePath"
              type="text"
              value={configDraft.chromePath || ''}
              onChange={e => handleChromePathChange(e.target.value)}
              placeholder="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono focus:outline-hidden focus:border-port-accent placeholder-gray-600"
            />
            <FolderPicker value={configDraft.chromePath || ''} mode="file" ariaLabel="Browse Chrome binary" onChange={handleChromePathChange} />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Browse files on the PortOS host. Point at Chrome Canary, Chromium, Brave, or any Chromium-based browser to differentiate the PortOS-managed browser from your daily-driver Chrome.
          </p>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor="macAppBundle" className="block text-sm text-gray-400 mb-1">
            macOS app bundle
            <span className="ml-2 text-xs text-gray-600">(headed mode only; leave empty for system default)</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id="macAppBundle"
              type="text"
              value={configDraft.macAppBundle || ''}
              onChange={e => setConfigDraft(d => ({ ...d, macAppBundle: e.target.value }))}
              placeholder="/Applications/Google Chrome Canary.app"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono focus:outline-hidden focus:border-port-accent placeholder-gray-600"
            />
            <FolderPicker value={configDraft.macAppBundle || ''} ariaLabel="Browse macOS app bundle" onChange={macAppBundle => setConfigDraft(d => ({ ...d, macAppBundle }))} />
          </div>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          onClick={handleSaveConfig}
          className="px-3 py-1.5 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 transition-colors"
        >
          Save Config
        </button>
      </div>
    </div>
  );
}

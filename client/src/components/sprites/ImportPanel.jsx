/**
 * The source-tree importer (#2895) for the Sprite Manager header — a modal that
 * imports/syncs approved sprite assets out of a managed app's checkout. Owns its
 * own open/app-list/error state; the page only needs to know an import landed so
 * it can refresh the library (and the open detail).
 */

import { useEffect, useState } from 'react';
import { Download, X, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import Modal from '../ui/Modal.jsx';
import AppContextPicker from '../AppContextPicker.jsx';
import { importSprites } from '../../services/apiSprites.js';
import { getApps } from '../../services/apiApps.js';

export default function ImportPanel({ onImported }) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState([]);
  const [appId, setAppId] = useState('');
  const [includeProps, setIncludeProps] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState([]);

  // Sprite sources are managed apps (we import/sync from an app's checkout),
  // so the picker is the source of truth for the path — no free-text root.
  // Archived apps and apps with no repoPath can't be a source.
  useEffect(() => {
    if (!open) return;
    getApps({ silent: true })
      .then((list) => setApps((list || []).filter((a) => a.repoPath && !a.archived)))
      .catch(() => setApps([]));
  }, [open]);

  const sourceRoot = apps.find((a) => a.id === appId)?.repoPath || '';

  const runImport = async () => {
    setImporting(true);
    setImportErrors([]);
    try {
      const { results, totals } = await importSprites({ sourceRoot, includeProps });
      if (totals.errors > 0) {
        // Keep the panel open and show WHICH files failed — a count alone
        // gives the user nothing to repair.
        setImportErrors(results.flatMap((r) => r.errors.map((e) => `${r.id}: ${e}`)));
        toast.error(`Import finished with ${totals.errors} error${totals.errors === 1 ? '' : 's'} — details below`);
      } else {
        toast.success(`Imported ${totals.subjects} subjects (${totals.files} files, ${totals.verified} hash-verified)`);
        setOpen(false);
      }
      onImported();
    } catch {
      // request() already toasted the failure — keep the panel open for a retry.
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 text-white rounded text-sm"
      >
        <Download className="w-4 h-4" /> Import
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="md" ariaLabel="Import production sprites" closeOnBackdrop={false}>
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Import production sprites</h3>
            <button onClick={() => setOpen(false)} aria-label="Close import panel" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-gray-400">
            Pick the managed app holding the sprite pipeline (expects <code>art-pipeline/characters/</code> and/or <code>game/assets/sprites/</code>
            in its repo). Only approved/final assets import — reference candidates and raw run intermediates stay behind.
          </p>
          <AppContextPicker
            apps={apps}
            value={appId}
            onChange={setAppId}
            label="Source app"
            placeholder="Select an app…"
            ariaLabel="Sprite source app"
            repoLabel="Source root"
            emptyRepoText="pick an app to import from"
            selectClassName="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white min-h-[44px]"
          />
          <label htmlFor="sprite-import-props" className="flex items-center gap-2 text-sm text-gray-300">
            <input
              id="sprite-import-props"
              type="checkbox"
              checked={includeProps}
              onChange={(e) => setIncludeProps(e.target.checked)}
            />
            Include props atlas families from the game tree
          </label>
          <button
            onClick={runImport}
            disabled={importing || !sourceRoot}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
          >
            {importing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {importing ? 'Importing…' : 'Run Import'}
          </button>
          {importErrors.length > 0 && (
            <ul className="max-h-40 overflow-y-auto space-y-1 text-xs text-port-error border border-port-border rounded p-2">
              {importErrors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
        </div>
      </Modal>
    </>
  );
}

import { useState, useEffect } from 'react';
import { Save, Download, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getSettings,
  updateSettings,
  getMortalLoomStatus,
  importMortalLoom
} from '../../services/api';

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function MortalLoomTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [path, setPath] = useState('');
  const [status, setStatus] = useState(null);
  const [lastImport, setLastImport] = useState(null);

  const refreshStatus = async () => {
    const s = await getMortalLoomStatus().catch(() => null);
    if (s) setStatus(s);
  };

  useEffect(() => {
    Promise.all([getSettings().catch(() => ({})), getMortalLoomStatus().catch(() => null)])
      .then(([settings, s]) => {
        const ml = settings?.mortalloom || {};
        setEnabled(Boolean(ml.enabled));
        setPath(ml.path || '');
        setLastImport(ml.lastImportAt || null);
        if (s) setStatus(s);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings({
        mortalloom: {
          enabled,
          path: path.trim(),
          lastImportAt: lastImport
        }
      });
      toast.success('MortalLoom settings saved');
      await refreshStatus();
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (!status?.exists) {
      toast.error('MortalLoom.json not found at configured path');
      return;
    }
    setImporting(true);
    const res = await importMortalLoom().catch(() => null);
    setImporting(false);
    if (!res?.ok) {
      toast.error('Import failed: ' + (res?.reason || 'unknown'));
      return;
    }
    const totalAdded = Object.values(res.added || {}).reduce((a, b) => a + b, 0);
    const totalSkipped = Object.values(res.skipped || {}).reduce((a, b) => a + b, 0);
    toast.success(`Imported ${totalAdded} new records (${totalSkipped} already present)`);
    const now = new Date().toISOString();
    setLastImport(now);
    await updateSettings({ mortalloom: { enabled, path: path.trim(), lastImportAt: now } }).catch(() => {});
    await refreshStatus();
  };

  if (loading) return <BrailleSpinner text="Loading MortalLoom settings" />;

  const effectivePath = path.trim() || status?.defaultPath || '';

  return (
    <div className="space-y-5">
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-white mb-1">MortalLoom iCloud Sync</h3>
          <p className="text-sm text-gray-400">
            Share Goals and Meatspace data with the MortalLoom iOS/macOS app. MortalLoom writes
            a canonical <code className="text-port-accent">MortalLoom.json</code> to its iCloud
            container &mdash; enabling this lets PortOS read from and import into the same file.
          </p>
          <a
            href="https://apps.apple.com/app/id6760883701"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline mt-2"
          >
            Get MortalLoom on the App Store <ExternalLink size={12} />
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="text-sm text-gray-400">Enabled</label>
          <button
            onClick={() => setEnabled(!enabled)}
            aria-pressed={enabled}
            className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${enabled ? 'bg-port-accent' : 'bg-port-border'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
          </button>
          <span className="basis-full sm:basis-auto text-xs text-gray-500">
            When enabled, Goals and Meatspace views surface MortalLoom data.
          </span>
        </div>

        <div className="space-y-1">
          <label className="block text-sm text-gray-400">iCloud file path</label>
          <input
            type="text"
            value={path}
            onChange={e => setPath(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent font-mono"
            placeholder={status?.defaultPath || ''}
          />
          <p className="text-xs text-gray-500">
            Leave blank to use the auto-detected MortalLoom container.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center justify-center min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <Save size={14} className="inline mr-1" />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleImport}
            disabled={importing || !status?.exists || !enabled}
            className="inline-flex items-center justify-center min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-white rounded-lg text-sm transition-colors disabled:opacity-50"
            title={!enabled ? 'Enable sync first' : !status?.exists ? 'MortalLoom.json not found' : 'Import into PortOS'}
          >
            <Download size={14} className="inline mr-1" />
            {importing ? 'Importing…' : 'Import from MortalLoom'}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Import is non-destructive: records already present in PortOS (matched by id) are kept
          as-is. Only missing records are added.
        </p>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-3">
        <h3 className="text-sm font-semibold text-white">iCloud file status</h3>
        <div className="text-xs text-gray-400 space-y-1 font-mono">
          <div className="flex items-start gap-2">
            {status?.exists ? (
              <CheckCircle2 size={14} className="text-green-400 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
            )}
            <span className="break-all">{effectivePath || '(no path)'}</span>
          </div>
          {status?.exists ? (
            <>
              <div>Size: {formatBytes(status.size)}</div>
              <div>Modified: {status.mtime ? new Date(status.mtime).toLocaleString() : '—'}</div>
              {lastImport && <div>Last import: {new Date(lastImport).toLocaleString()}</div>}
            </>
          ) : (
            <div className="text-yellow-400">File not found. Open MortalLoom on iPhone/Mac to create it, or verify the path.</div>
          )}
        </div>
        {status?.summary && (
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-300 mt-2">
            <div>Goals: <span className="text-white">{status.summary.goals}</span></div>
            <div>Alcohol drinks: <span className="text-white">{status.summary.alcoholDrinks}</span></div>
            <div>Nicotine entries: <span className="text-white">{status.summary.nicotineEntries}</span></div>
            <div>Blood tests: <span className="text-white">{status.summary.bloodTests}</span></div>
            <div>Body entries: <span className="text-white">{status.summary.bodyEntries}</span></div>
            <div>Epigenetic tests: <span className="text-white">{status.summary.epigeneticTests}</span></div>
            <div>Eye exams: <span className="text-white">{status.summary.eyeExams}</span></div>
            <div>Sauna sessions: <span className="text-white">{status.summary.saunaSessions}</span></div>
            <div>Profile: <span className="text-white">{status.summary.hasProfile ? 'yes' : 'no'}</span></div>
            <div>Genome: <span className="text-white">{status.summary.hasGenome ? 'yes' : 'no'}</span></div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MortalLoomTab;

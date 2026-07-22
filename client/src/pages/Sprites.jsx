import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PersonStanding, Package, Download, FolderOpen, X, RefreshCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import { listSpriteRecords, getSpriteRecord, importSprites } from '../services/apiSprites.js';
import { formatBytes, timeAgo } from '../utils/formatters.js';

// Sprite Manager (issue #2895, phase 1): read-only library over imported
// production sprites — characters (reference sets, walk strips, runtime
// atlases) and props atlas families — plus the source-tree importer. The
// generation workflow (reference → anchors → animation → publish) lands in
// later phases.

const IMAGE_EXT = /\.(png|gif|webp|jpe?g)$/i;

function topLevelGroup(assetPath) {
  const idx = assetPath.indexOf('/');
  return idx < 0 ? '' : assetPath.slice(0, idx);
}

function ImportPanel({ onImported }) {
  const [open, setOpen] = useState(false);
  const [sourceRoot, setSourceRoot] = useState('');
  const [includeProps, setIncludeProps] = useState(true);
  const [importing, setImporting] = useState(false);

  const runImport = async () => {
    setImporting(true);
    try {
      const { totals } = await importSprites({ sourceRoot: sourceRoot.trim(), includeProps });
      toast.success(`Imported ${totals.subjects} subjects (${totals.files} files, ${totals.verified} hash-verified${totals.errors ? `, ${totals.errors} errors` : ''})`);
      setOpen(false);
      onImported();
    } catch {
      // request() already toasted the failure — keep the panel open for a retry.
    } finally {
      setImporting(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 text-white rounded text-sm"
      >
        <Download className="w-4 h-4" /> Import
      </button>
    );
  }

  return (
    <div className="w-full bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Import production sprites</h3>
        <button onClick={() => setOpen(false)} aria-label="Close import panel" className="text-gray-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-gray-400">
        Point at a sprite-pipeline checkout (expects <code>art-pipeline/characters/</code> and/or <code>game/assets/sprites/</code>).
        Only approved/final assets import — reference candidates and raw run intermediates stay behind.
      </p>
      <div>
        <label htmlFor="sprite-import-source" className="block text-xs text-gray-400 mb-1">Source root path</label>
        <input
          id="sprite-import-source"
          type="text"
          value={sourceRoot}
          onChange={(e) => setSourceRoot(e.target.value)}
          placeholder="~/path/to/game-project"
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
        />
      </div>
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
        disabled={importing || !sourceRoot.trim()}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
      >
        {importing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        {importing ? 'Importing…' : 'Run Import'}
      </button>
    </div>
  );
}

function RecordSection({ title, icon: Icon, items, selectedId, onSelect }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500 mb-1.5">
        <Icon className="w-3.5 h-3.5" /> {title}
      </h3>
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              className={`w-full text-left px-3 py-2 rounded text-sm ${selectedId === r.id ? 'bg-port-accent/20 text-white border border-port-accent' : 'bg-port-card text-gray-300 border border-port-border hover:border-gray-500'}`}
            >
              <span className="font-medium">{r.name}</span>
              <span className="block text-xs text-gray-500">{r.status}{r.chromaKey ? ` · key ${r.chromaKey}` : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecordList({ records, selectedId, onSelect }) {
  return (
    <div className="space-y-4">
      <RecordSection title="Characters" icon={PersonStanding} items={records.filter((r) => r.kind === 'character')} selectedId={selectedId} onSelect={onSelect} />
      <RecordSection title="Props" icon={Package} items={records.filter((r) => r.kind !== 'character')} selectedId={selectedId} onSelect={onSelect} />
    </div>
  );
}

function AssetGroups({ recordId, assets }) {
  const [preview, setPreview] = useState(null);
  const groups = useMemo(() => assets.reduce((acc, a) => {
    const g = topLevelGroup(a.path) || 'files';
    (acc[g] ||= []).push(a);
    return acc;
  }, {}), [assets]);
  return (
    <div className="space-y-4">
      {Object.entries(groups).map(([group, files]) => (
        <div key={group}>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-300 mb-2">
            <FolderOpen className="w-4 h-4" /> {group}
            <span className="text-xs text-gray-500 font-normal">({files.length})</span>
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {files.map((a) => {
              const url = `/data/sprites/${encodeURIComponent(recordId)}/${a.path.split('/').map(encodeURIComponent).join('/')}`;
              return IMAGE_EXT.test(a.path) ? (
                <button
                  key={a.path}
                  onClick={() => setPreview({ url, path: a.path })}
                  className="bg-port-bg border border-port-border rounded p-1 hover:border-port-accent"
                  title={a.path}
                >
                  <img src={url} alt={a.path} loading="lazy" className="w-full h-20 object-contain" style={{ imageRendering: 'pixelated' }} />
                  <span className="block text-[10px] text-gray-500 truncate">{a.path.split('/').pop()}</span>
                </button>
              ) : (
                <a
                  key={a.path}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-port-bg border border-port-border rounded p-2 text-xs text-gray-400 hover:border-gray-500 truncate"
                  title={a.path}
                >
                  {a.path.split('/').pop()}
                  <span className="block text-[10px] text-gray-600">{formatBytes(a.size)}</span>
                </a>
              );
            })}
          </div>
        </div>
      ))}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="dialog"
          aria-label={`Preview ${preview.path}`}
          onClick={() => setPreview(null)}
        >
          <div className="max-w-full max-h-full">
            <img src={preview.url} alt={preview.path} className="max-w-full max-h-[85vh] object-contain" style={{ imageRendering: 'pixelated' }} />
            <p className="text-center text-xs text-gray-400 mt-2">{preview.path}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Sprites() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [records, setRecords] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailMissing, setDetailMissing] = useState(false);

  const refresh = useCallback(() => {
    listSpriteRecords().then(setRecords);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!id) { setDetail(null); setDetailMissing(false); return; }
    setDetail(null);
    setDetailMissing(false);
    getSpriteRecord(id, { silent: true })
      .then(setDetail)
      .catch(() => setDetailMissing(true));
  }, [id]);

  return (
    <div className="flex flex-col md:flex-row gap-4 h-full">
      <aside className="md:w-64 shrink-0 space-y-3">
        <ImportPanel onImported={refresh} />
        {records === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : records.length === 0 ? (
          <p className="text-sm text-gray-500">
            No sprites yet. Import a production set from a sprite-pipeline checkout to get started.
          </p>
        ) : (
          <RecordList records={records} selectedId={id} onSelect={(rid) => navigate(`/media/sprites/${rid}`)} />
        )}
      </aside>
      <section className="flex-1 min-w-0">
        {!id ? (
          <p className="text-sm text-gray-500">Select a sprite to browse its reference set, animation strips, and atlases.</p>
        ) : detailMissing ? (
          <div className="text-sm text-gray-400">
            Sprite not found.{' '}
            <button onClick={() => navigate('/media/sprites')} className="text-port-accent hover:underline">Back to library</button>
          </div>
        ) : !detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                {detail.record.kind === 'character' ? <PersonStanding className="w-5 h-5" /> : <Package className="w-5 h-5" />}
                {detail.record.name}
              </h2>
              <p className="text-xs text-gray-500">
                {detail.record.kind} · {detail.record.status}
                {detail.record.chromaKey && (
                  <>
                    {' · chroma key '}
                    <span className="inline-block w-3 h-3 rounded-sm align-middle border border-port-border" style={{ backgroundColor: detail.record.chromaKey }} />{' '}
                    {detail.record.chromaKey}
                  </>
                )}
                {detail.record.importedFrom?.importedAt && ` · imported ${timeAgo(detail.record.importedFrom.importedAt)}`}
              </p>
              {detail.record.spec?.archetype && (
                <p className="text-xs text-gray-500">archetype: {detail.record.spec.archetype}</p>
              )}
            </div>
            {detail.assets.length === 0 ? (
              <p className="text-sm text-gray-500">No assets on disk for this record.</p>
            ) : (
              <AssetGroups recordId={detail.record.id} assets={detail.assets} />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

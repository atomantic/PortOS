/**
 * Sharing page — cross-network share buckets via cloud-synced folders.
 *
 * Lists registered buckets, lets the user add/remove buckets and toggle each
 * one's import mode (auto-merge vs inbox), and surfaces the per-bucket inbox
 * + activity log. Top strip lets the user configure the display name + bio
 * that get stamped as the source on every outgoing share.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Share2, Plus, Trash2, Folder, Inbox, History, Save, Loader2, Check, X, Users, AlertCircle, RefreshCw,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import FolderPicker from '../components/FolderPicker';
import socket from '../services/socket';
import {
  listShareBuckets, createShareBucket, updateShareBucket, deleteShareBucket,
  listShareInbox, promoteShareInboxItem, dismissShareInboxItem,
  listShareActivity, getSettings, updateSettings,
} from '../services/api';

const emptyForm = () => ({ name: '', path: '', mode: 'inbox', displayNameOverride: '', bioOverride: '' });

// A subscription row counts as "live" when its latest manifest was queued
// within this window. Re-exports fire on every record edit (debounced ~3s
// server-side) and propagate via chokidar in <1s — so a row received this
// recently means the sender is actively editing the record right now.
const SUBSCRIPTION_LIVE_WINDOW_MS = 5 * 60 * 1000;

export function isLiveSubscription(item, now = Date.now()) {
  if (!item || !item.subscription) return false;
  const receivedMs = Date.parse(item.receivedAt);
  if (!Number.isFinite(receivedMs)) return false;
  return (now - receivedMs) < SUBSCRIPTION_LIVE_WINDOW_MS;
}

export default function Sharing() {
  const [buckets, setBuckets] = useState([]);
  const [localSchemaVersion, setLocalSchemaVersion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [activeTab, setActiveTab] = useState('inbox'); // inbox | activity | settings

  // Display name + bio settings — used as the source attribution on outgoing shares.
  const [sharingDisplayName, setSharingDisplayName] = useState('');
  const [sharingBio, setSharingBio] = useState('');
  const [savedDisplayName, setSavedDisplayName] = useState('');
  const [savedBio, setSavedBio] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  const [inboxByBucket, setInboxByBucket] = useState({}); // bucketId → items[]
  const [activityByBucket, setActivityByBucket] = useState({});

  const [armedRemove, setArmedRemove] = useState(null);

  // Load buckets + settings on mount.
  useEffect(() => {
    Promise.all([
      listShareBuckets({ silent: true }).catch(() => ({ buckets: [] })),
      getSettings().catch(() => ({})),
    ]).then(([bResp, settings]) => {
      const list = bResp?.buckets || [];
      setBuckets(list);
      setLocalSchemaVersion(bResp?.localSchemaVersion ?? null);
      if (list.length > 0) setSelectedId(list[0].id);
      const display = settings?.sharingDisplayName || '';
      const bio = settings?.sharingBio || '';
      setSharingDisplayName(display);
      setSharingBio(bio);
      setSavedDisplayName(display);
      setSavedBio(bio);
      setLoading(false);
    });
  }, []);

  // Lazy-load inbox + activity when a bucket is selected.
  const loadInbox = (bucketId) => {
    listShareInbox(bucketId, { silent: true })
      .then((r) => setInboxByBucket((m) => ({ ...m, [bucketId]: r?.items || [] })))
      .catch(() => setInboxByBucket((m) => ({ ...m, [bucketId]: [] })));
  };
  const loadActivity = (bucketId) => {
    listShareActivity(bucketId, { silent: true })
      .then((r) => setActivityByBucket((m) => ({ ...m, [bucketId]: r?.manifests || [] })))
      .catch(() => setActivityByBucket((m) => ({ ...m, [bucketId]: [] })));
  };
  useEffect(() => {
    if (!selectedId) return;
    loadInbox(selectedId);
    loadActivity(selectedId);
  }, [selectedId]);

  // Live socket updates: inbox changes + new manifests.
  useEffect(() => {
    const onInboxUpdated = ({ bucketId }) => {
      if (bucketId) loadInbox(bucketId);
    };
    const onManifestProcessed = ({ bucketId }) => {
      if (bucketId) {
        loadInbox(bucketId);
        loadActivity(bucketId);
      }
    };
    socket.on('sharing:inbox-updated', onInboxUpdated);
    socket.on('sharing:manifest-processed', onManifestProcessed);
    return () => {
      socket.off('sharing:inbox-updated', onInboxUpdated);
      socket.off('sharing:manifest-processed', onManifestProcessed);
    };
  }, []);

  const handleCreate = async (e) => {
    e?.preventDefault();
    const name = form.name.trim();
    const path = form.path.trim();
    if (!name) {
      toast.error('Bucket name is required');
      return;
    }
    if (!path) {
      toast.error('Bucket path is required');
      return;
    }
    setCreating(true);
    const result = await createShareBucket({
      name,
      path,
      mode: form.mode,
      displayNameOverride: form.displayNameOverride.trim() || null,
      bioOverride: form.bioOverride.trim() || null,
    }).catch((err) => {
      toast.error(err.message || 'Failed to register bucket');
      return null;
    });
    setCreating(false);
    if (!result?.bucket) return;
    setBuckets((prev) => [...prev, result.bucket].sort((a, b) => a.name.localeCompare(b.name)));
    setSelectedId(result.bucket.id);
    setForm(emptyForm());
    setShowAdd(false);
    toast.success(`Registered bucket "${result.bucket.name}"`);
  };

  const handleDelete = async (bucket) => {
    if (armedRemove !== bucket.id) {
      setArmedRemove(bucket.id);
      return;
    }
    setArmedRemove(null);
    const prior = buckets;
    setBuckets((prev) => prev.filter((b) => b.id !== bucket.id));
    if (selectedId === bucket.id) setSelectedId(prior[0]?.id !== bucket.id ? prior[0]?.id : (prior[1]?.id || null));
    await deleteShareBucket(bucket.id).catch((err) => {
      toast.error(err.message || 'Failed to remove bucket');
      setBuckets(prior);
    });
  };

  const handleModeToggle = async (bucket) => {
    const nextMode = bucket.mode === 'auto-merge' ? 'inbox' : 'auto-merge';
    const result = await updateShareBucket(bucket.id, { mode: nextMode }).catch((err) => {
      toast.error(err.message || 'Failed to update mode');
      return null;
    });
    if (!result?.bucket) return;
    setBuckets((prev) => prev.map((b) => (b.id === bucket.id ? result.bucket : b)));
    toast.success(`Bucket "${result.bucket.name}" now ${nextMode}`);
  };

  const handleSaveDisplayName = async () => {
    setSavingDisplayName(true);
    const patch = {
      sharingDisplayName: sharingDisplayName.trim(),
      sharingBio: sharingBio.trim(),
    };
    const merged = await updateSettings(patch).catch((err) => {
      toast.error(err.message || 'Failed to save');
      return null;
    });
    setSavingDisplayName(false);
    if (!merged) return;
    setSavedDisplayName(patch.sharingDisplayName);
    setSavedBio(patch.sharingBio);
    toast.success('Saved');
  };

  const handlePromote = async (bucketId, manifestId) => {
    const result = await promoteShareInboxItem(bucketId, manifestId).catch((err) => {
      toast.error(err.message || 'Promote failed');
      return null;
    });
    if (!result) return;
    setInboxByBucket((m) => ({ ...m, [bucketId]: (m[bucketId] || []).filter((it) => it.manifestId !== manifestId) }));
    const applied = result.outcome?.applied ?? 0;
    toast.success(`Imported — ${applied} record${applied === 1 ? '' : 's'}`);
  };

  const handleDismiss = async (bucketId, manifestId) => {
    const result = await dismissShareInboxItem(bucketId, manifestId).catch((err) => {
      toast.error(err.message || 'Dismiss failed');
      return null;
    });
    if (!result) return;
    setInboxByBucket((m) => ({ ...m, [bucketId]: (m[bucketId] || []).filter((it) => it.manifestId !== manifestId) }));
  };

  const selected = buckets.find((b) => b.id === selectedId) || null;
  const displayNameDirty = sharingDisplayName !== savedDisplayName || sharingBio !== savedBio;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Share2 className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Sharing</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
        >
          <Plus size={16} />
          Add bucket
        </button>
      </div>

      <p className="text-sm text-gray-400 mb-6">
        Share pipeline series, universes, and individual media with peers on different networks by exporting into a
        cloud-synced folder (Google Drive, Dropbox, iCloud, Syncthing, USB stick). PortOS reads/writes the folder; the
        cloud-sync app handles the cross-network transport.
        <span className="block mt-1 text-[11px] text-gray-500">
          ⚠️ The cloud provider sees the bucket contents as plaintext. Treat sharing trust like you would a Google Drive folder share.
        </span>
      </p>

      {/* Display name + bio strip */}
      <div className="mb-6 p-4 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Users size={14} className="text-gray-500" />
          <h2 className="text-sm font-medium text-white">Your display name</h2>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          This name is stamped as the <em>source</em> on every share you send. Recipients see it as attribution. Each bucket can override this with its own name.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-3 items-start">
          <input
            type="text"
            value={sharingDisplayName}
            onChange={(e) => setSharingDisplayName(e.target.value)}
            placeholder="Display name (e.g. atomantic)"
            maxLength={120}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          />
          <input
            type="text"
            value={sharingBio}
            onChange={(e) => setSharingBio(e.target.value)}
            placeholder="Optional bio / contact note (visible to recipients)"
            maxLength={2000}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          />
          <button
            type="button"
            onClick={handleSaveDisplayName}
            disabled={!displayNameDirty || savingDisplayName}
            className="inline-flex items-center gap-2 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {savingDisplayName ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </div>

      {showAdd && (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Bucket name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Creative circle"
                maxLength={120}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Import mode</label>
              <select
                value={form.mode}
                onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              >
                <option value="inbox">Inbox — review before importing</option>
                <option value="auto-merge">Auto-merge — apply immediately (trusted)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Folder path
            </label>
            <div className="flex gap-2 items-stretch">
              <input
                type="text"
                value={form.path}
                onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
                placeholder="/Users/you/Library/CloudStorage/GoogleDrive-…/PortOS Shares/creative-circle"
                className="flex-1 min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
              />
              <FolderPicker
                value={form.path}
                onChange={(path) => setForm((f) => ({ ...f, path }))}
              />
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Pick a folder that's synced by your cloud-storage app. PortOS will create <code>manifests/</code>, <code>records/</code>, and <code>assets/</code> inside it.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Display name override (optional)</label>
              <input
                type="text"
                value={form.displayNameOverride}
                onChange={(e) => setForm((f) => ({ ...f, displayNameOverride: e.target.value }))}
                placeholder="Use a different name in this bucket"
                maxLength={120}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Bio override (optional)</label>
              <input
                type="text"
                value={form.bioOverride}
                onChange={(e) => setForm((f) => ({ ...f, bioOverride: e.target.value }))}
                placeholder="Different bio for this bucket"
                maxLength={2000}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-2 px-3 py-2 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : null}
              Register bucket
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="px-3 py-2 rounded text-gray-400 hover:text-white text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        {/* Bucket list */}
        <aside>
          {loading ? (
            <div className="text-gray-500 text-sm">Loading…</div>
          ) : buckets.length === 0 ? (
            <div className="p-4 bg-port-card border border-port-border rounded-lg text-sm text-gray-500">
              No buckets yet. Click <span className="text-port-accent">Add bucket</span> to register a synced folder.
            </div>
          ) : (
            <ul className="space-y-2">
              {buckets.map((b) => {
                const inboxCount = (inboxByBucket[b.id] || []).length;
                const isSelected = selectedId === b.id;
                const incompatible = b.schemaCompatible === false;
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(b.id)}
                      className={`w-full text-left p-3 rounded-lg border ${isSelected ? 'bg-port-card border-port-accent/40' : 'bg-port-card border-port-border'} hover:border-port-accent/30 transition-colors`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-white text-sm font-medium truncate flex items-center gap-1">
                          {incompatible ? <AlertCircle size={12} className="text-port-error shrink-0" /> : null}
                          <span className="truncate">{b.name}</span>
                        </span>
                        {inboxCount > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[18px] px-1.5 py-0.5 rounded-full bg-port-accent text-[10px] text-white">
                            {inboxCount}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate mt-1 flex items-center gap-1">
                        <Folder size={10} />
                        {b.path}
                      </div>
                      <div className="text-[10px] text-gray-600 mt-1 flex items-center gap-2 flex-wrap">
                        <span>{b.mode === 'auto-merge' ? 'auto-merge' : 'inbox'}</span>
                        {b.bucketSchemaVersion != null && (
                          <span className={incompatible ? 'text-port-error' : ''} title={incompatible ? `Bucket protocol v${b.bucketSchemaVersion} > your PortOS (v${b.localSchemaVersion}). Upgrade required to read incoming shares.` : `Protocol v${b.bucketSchemaVersion}`}>
                            schema v{b.bucketSchemaVersion}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Detail panel */}
        <section>
          {!selected ? (
            <div className="p-6 bg-port-card border border-port-border rounded-lg text-sm text-gray-500">
              Pick a bucket on the left to see its inbox + activity.
            </div>
          ) : (
            <div>
              {/* Tabs */}
              <div className="flex gap-1 mb-3 border-b border-port-border">
                <TabButton active={activeTab === 'inbox'} onClick={() => setActiveTab('inbox')} icon={Inbox} label="Inbox" count={(inboxByBucket[selected.id] || []).length} />
                <TabButton active={activeTab === 'activity'} onClick={() => setActiveTab('activity')} icon={History} label="Activity" />
                <TabButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={Save} label="Settings" />
              </div>

              {activeTab === 'inbox' && (
                <Inboxlist
                  bucket={selected}
                  items={inboxByBucket[selected.id] || []}
                  onPromote={(id) => handlePromote(selected.id, id)}
                  onDismiss={(id) => handleDismiss(selected.id, id)}
                />
              )}
              {activeTab === 'activity' && (
                <ActivityList manifests={activityByBucket[selected.id] || []} />
              )}
              {activeTab === 'settings' && (
                <SettingsPanel
                  bucket={selected}
                  onToggleMode={() => handleModeToggle(selected)}
                  onDelete={() => handleDelete(selected)}
                  armed={armedRemove === selected.id}
                />
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs ${active ? 'border-b-2 border-port-accent text-white' : 'border-b-2 border-transparent text-gray-400 hover:text-white'}`}
    >
      <Icon size={12} />
      {label}
      {typeof count === 'number' && count > 0 ? (
        <span className="inline-flex items-center justify-center min-w-[16px] px-1 py-0 rounded-full bg-port-accent text-[10px] text-white">{count}</span>
      ) : null}
    </button>
  );
}

function Inboxlist({ bucket, items, onPromote, onDismiss }) {
  if (bucket.mode === 'auto-merge') {
    return (
      <div className="p-4 bg-port-card border border-port-border rounded-lg text-sm text-gray-500 flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 text-port-accent" />
        <div>
          This bucket is in <strong className="text-white">auto-merge</strong> mode — incoming shares are applied immediately. Switch to <strong className="text-white">inbox</strong> in the Settings tab to require manual review.
        </div>
      </div>
    );
  }
  if (items.length === 0) {
    return <div className="p-4 bg-port-card border border-port-border rounded-lg text-sm text-gray-500">No pending imports.</div>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.manifestId} className="p-3 bg-port-card border border-port-border rounded-lg">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white flex items-center gap-2 flex-wrap">
                <span className="text-port-accent">{item.source}</span>
                {item.producedByVersion && item.producedByVersion !== 'unknown' && (
                  <span className="text-gray-500 text-[11px]">(PortOS {item.producedByVersion})</span>
                )}
                <span className="text-gray-600">· {item.kind}</span>
                <span className="text-gray-600">· {new Date(item.receivedAt || item.createdAt).toLocaleString()}</span>
                {isLiveSubscription(item) && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-port-success/10 border border-port-success/30 text-[10px] text-port-success"
                    title={`Subscription refreshed within the last ${SUBSCRIPTION_LIVE_WINDOW_MS / 60000} minutes — sender is actively editing`}
                  >
                    <RefreshCw size={9} className="animate-spin [animation-duration:3s]" />
                    live
                  </span>
                )}
              </div>
              {item.sourceBio ? (
                <div className="text-[11px] text-gray-500 mt-0.5 italic">{item.sourceBio}</div>
              ) : null}
              {Array.isArray(item.summary) && item.summary.length > 0 ? (
                <ul className="mt-1 text-[12px] text-gray-400 list-disc pl-4">
                  {item.summary.map((s, i) => (
                    <li key={i}><span className="text-gray-600">{s.kind}:</span> {s.label}</li>
                  ))}
                </ul>
              ) : null}
              <div className="text-[11px] text-gray-500 mt-1 flex flex-wrap gap-3">
                {item.assetCount ? <span>{item.assetCount} asset{item.assetCount === 1 ? '' : 's'}</span> : null}
                {item.collectionItemCount ? (
                  <span>+ {item.collectionItemCount} collection item{item.collectionItemCount === 1 ? '' : 's'}{item.collectionName ? ` (${item.collectionName})` : ''}</span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => onPromote(item.manifestId)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-success/20 text-port-success hover:bg-port-success/30 border border-port-success/30"
                title="Apply to local state"
              >
                <Check size={12} />
                Import
              </button>
              <button
                type="button"
                onClick={() => onDismiss(item.manifestId)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-port-error border border-port-border"
                title="Discard this share"
              >
                <X size={12} />
                Dismiss
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ActivityList({ manifests }) {
  if (manifests.length === 0) {
    return <div className="p-4 bg-port-card border border-port-border rounded-lg text-sm text-gray-500">No share activity yet.</div>;
  }
  return (
    <ul className="space-y-1.5">
      {manifests.map((m) => (
        <li key={m.id} className="p-2 bg-port-card border border-port-border rounded text-xs flex items-center gap-2 flex-wrap">
          <span className="text-gray-500">{new Date(m.createdAt).toLocaleString()}</span>
          <span className="text-port-accent">{m.source}</span>
          {m.producedByVersion && m.producedByVersion !== 'unknown' && (
            <span className="text-gray-500 text-[10px]">v{m.producedByVersion}</span>
          )}
          <span className="text-gray-600">·</span>
          <span className="text-gray-300">{m.kind}</span>
          <span className="text-gray-600">·</span>
          <span className="text-gray-500">{(m.recordIds || []).length} record{(m.recordIds || []).length === 1 ? '' : 's'}, {(m.assetRefs || []).length} asset{(m.assetRefs || []).length === 1 ? '' : 's'}</span>
        </li>
      ))}
    </ul>
  );
}

function SettingsPanel({ bucket, onToggleMode, onDelete, armed }) {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-port-card border border-port-border rounded-lg">
        <h3 className="text-sm font-medium text-white mb-2">Import mode</h3>
        <div className="flex items-center gap-3">
          <span className={`text-sm ${bucket.mode === 'inbox' ? 'text-white' : 'text-gray-500'}`}>Inbox (review)</span>
          <button
            type="button"
            onClick={onToggleMode}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${bucket.mode === 'auto-merge' ? 'bg-port-accent' : 'bg-port-border'}`}
            aria-label="Toggle mode"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${bucket.mode === 'auto-merge' ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
          <span className={`text-sm ${bucket.mode === 'auto-merge' ? 'text-white' : 'text-gray-500'}`}>Auto-merge</span>
        </div>
        <p className="text-[11px] text-gray-500 mt-2">
          Auto-merge applies incoming records directly (LWW by updatedAt). Inbox queues them for explicit review.
        </p>
      </div>
      <div className="p-4 bg-port-card border border-port-border rounded-lg">
        <h3 className="text-sm font-medium text-white mb-1">Folder</h3>
        <div className="text-xs font-mono text-gray-400 break-all">{bucket.path}</div>
        <p className="text-[11px] text-gray-500 mt-2">
          To move a bucket to a different folder, remove this bucket and register a new one at the target path.
        </p>
      </div>
      <div className="p-4 bg-port-card border border-port-error/30 rounded-lg">
        <h3 className="text-sm font-medium text-port-error mb-2">Remove bucket</h3>
        <p className="text-[11px] text-gray-500 mb-3">
          Stops watching the folder for new shares and drops the bucket from PortOS. Files inside the folder are not deleted — your cloud-sync app keeps the data.
        </p>
        <button
          type="button"
          onClick={onDelete}
          className={`inline-flex items-center gap-2 px-3 py-2 rounded text-xs ${armed ? 'bg-port-error text-white' : 'bg-port-bg text-port-error border border-port-error/40 hover:bg-port-error/10'}`}
        >
          <Trash2 size={12} />
          {armed ? 'Click again to confirm' : 'Remove bucket'}
        </button>
      </div>
    </div>
  );
}

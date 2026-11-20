import { Network, Edit3, Check, X, Database, Brain, CheckCircle2, Clock, Globe } from 'lucide-react';
import toast from '../ui/Toast';
import { updateSelfInstance } from '../../services/apiSystem.js';
import { SNAPSHOT_CATEGORIES } from './syncCategoryMeta';

export default function SelfCard({ self, onUpdate, syncStatus, tailnetInfo, editing, setEditing, name, setName }) {

  const startEdit = () => {
    setName(self?.name || '');
    setEditing(true);
  };

  const saveName = async () => {
    if (!name.trim()) return;
    const result = await updateSelfInstance({ name: name.trim() }).catch(() => null);
    if (!result) return;
    document.title = `PortOS: ${name.trim()}`;
    onUpdate();
    setEditing(false);
    toast.success('Instance name updated');
  };

  const defaultFullSync = self?.defaultPeerFullSync === true;
  const toggleDefaultFullSync = async () => {
    const result = await updateSelfInstance({ defaultPeerFullSync: !defaultFullSync }).catch(() => null);
    if (!result) return;
    onUpdate();
    toast.success(`New peers will ${!defaultFullSync ? 'default to full mirror' : 'start with no categories'}`);
  };

  if (!self) return null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">This Instance</h3>
        <Network size={16} className="text-port-accent" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {editing ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                aria-label="Instance name"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveName()}
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white focus:outline-hidden focus:border-port-accent"
                autoFocus
              />
              <button onClick={saveName} aria-label="Save name" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-port-success hover:text-port-success/80">
                <Check size={16} />
              </button>
              <button onClick={() => setEditing(false)} aria-label="Cancel" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-500 hover:text-white">
                <X size={16} />
              </button>
            </div>
          ) : (
            <>
              <span className="text-white font-semibold text-lg">{self.name}</span>
              <button onClick={startEdit} aria-label="Edit" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-500 hover:text-white">
                <Edit3 size={14} />
              </button>
            </>
          )}
        </div>
        <p className="text-xs text-gray-500 font-mono">{self.instanceId}</p>
        {tailnetInfo?.self ? (
          <div className="flex items-center gap-1.5 text-[11px] mt-1" title="This instance's Tailscale MagicDNS name — peers can reach you over HTTPS at this name">
            <Globe size={11} className="text-port-accent" />
            <span className="font-mono text-port-accent">{tailnetInfo.self}</span>
            <span className="text-gray-600">·</span>
            <span className="text-gray-500">tailnet DNS</span>
          </div>
        ) : tailnetInfo === null ? null : (
          <div className="flex items-center gap-1.5 text-[11px] mt-1 text-gray-500" title="No MagicDNS name detected for this instance">
            <Globe size={11} />
            <span>No tailnet DNS — peers will reach you by IP</span>
          </div>
        )}
        <button
          onClick={toggleDefaultFullSync}
          className="mt-2 pt-2 border-t border-port-border/50 flex items-start gap-2 w-full text-left group"
          title="When on, peers you add will start in full-mirror mode automatically"
        >
          <div className={`w-3 h-3 mt-0.5 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
            defaultFullSync ? 'bg-port-accent border-port-accent' : 'border-gray-600 bg-transparent'
          }`}>
            {defaultFullSync && <Check size={8} className="text-white" />}
          </div>
          <Globe size={12} className={`mt-0.5 ${defaultFullSync ? 'text-port-accent' : 'text-gray-500'}`} />
          <div className="flex-1 min-w-0">
            <span className={`text-xs ${defaultFullSync ? 'text-white' : 'text-gray-400'} group-hover:text-gray-300`}>Default new peers to full mirror</span>
            <p className="text-[10px] text-gray-600 leading-snug">Applies to peers added from now on; existing peers are unchanged.</p>
          </div>
        </button>
        {syncStatus?.local && (
          <div className="mt-2 pt-2 border-t border-port-border/50 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
            <span className="flex items-center gap-1.5 min-w-0 truncate">
              <Brain size={12} className="shrink-0" /> <span className="truncate">Brain seq: {syncStatus.local.brainSeq}</span>
            </span>
            <span className="flex items-center gap-1.5 min-w-0 truncate">
              <Database size={12} className="shrink-0" /> <span className="truncate">Memory seq: {syncStatus.local.memorySeq}</span>
            </span>
            {SNAPSHOT_CATEGORIES.map(({ key, label, icon: Icon }) => {
                const hasChecksum = !!syncStatus.local.checksums?.[key];
                return (
                  <span key={key} className="flex items-center gap-1.5 min-w-0">
                    <Icon size={12} className="shrink-0" />
                    <span className="truncate">{label}:</span>
                    {hasChecksum ? (
                      <CheckCircle2 size={11} className="text-port-success shrink-0" />
                    ) : (
                      <Clock size={11} className="text-gray-600 shrink-0" />
                    )}
                  </span>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

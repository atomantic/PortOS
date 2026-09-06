import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit2, Trash2, Cpu, Check, X, Shield, Sparkles } from 'lucide-react';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import * as api from '../../services/api';
import { effortAwareModelOptions, effortSurvivingModel } from '../../utils/providers';

const ROLES = [
  { key: 'architect', label: 'Architect', description: 'Plans, analyzes, writes specs, and coordinates delegation' },
  { key: 'implementer', label: 'Implementer', description: 'Executes individual specs in isolated context' },
  { key: 'reviewer', label: 'Reviewer', description: 'Evaluates correctness against spec and guidelines' },
];

const GENERAL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const emptyProfileDraft = () => ({
  id: '',
  name: '',
  description: '',
  profile: {
    architect: { provider: '', model: '', effort: '' },
    implementer: { provider: '', model: '', effort: '' },
    reviewer: { provider: '', model: '', effort: '' },
  },
});

export default function OrchestrationTab() {
  const [profiles, setProfiles] = useState([]);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingProfile, setEditingProfile] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [profList, provList] = await Promise.all([
        api.getOrchestrationProfiles({ silent: true }).catch(() => []),
        api.getProviders({ silent: true }).catch(() => []),
      ]);
      setProfiles(profList || []);
      setProviders((provList || []).filter((p) => p.enabled));
    } catch (err) {
      toast.error(`Failed to load orchestration data: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStartCreate = () => {
    setEditingProfile(emptyProfileDraft());
    setIsNew(true);
  };

  const handleStartEdit = (profile) => {
    setEditingProfile({
      id: profile.id,
      name: profile.name,
      description: profile.description || '',
      profile: {
        architect: {
          provider: profile.profile?.architect?.provider || '',
          model: profile.profile?.architect?.model || '',
          effort: profile.profile?.architect?.effort || '',
        },
        implementer: {
          provider: profile.profile?.implementer?.provider || '',
          model: profile.profile?.implementer?.model || '',
          effort: profile.profile?.implementer?.effort || '',
        },
        reviewer: {
          provider: profile.profile?.reviewer?.provider || '',
          model: profile.profile?.reviewer?.model || '',
          effort: profile.profile?.reviewer?.effort || '',
        },
      },
    });
    setIsNew(false);
  };

  const handleCancelEdit = () => {
    setEditingProfile(null);
    setIsNew(false);
  };

  const handleSave = async () => {
    if (!editingProfile.name.trim()) {
      toast.error('Profile name is required');
      return;
    }

    const id = (editingProfile.id || editingProfile.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-')).trim();
    if (!id) {
      toast.error('Valid profile ID is required');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        id,
        name: editingProfile.name.trim(),
        description: editingProfile.description?.trim() || '',
        profile: editingProfile.profile,
      };

      if (isNew) {
        await api.saveOrchestrationProfile(payload);
        toast.success(`Profile "${payload.name}" created`);
      } else {
        await api.updateOrchestrationProfile(id, payload);
        toast.success(`Profile "${payload.name}" updated`);
      }

      setEditingProfile(null);
      setIsNew(false);
      await loadData();
    } catch (err) {
      toast.error(`Failed to save profile: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Are you sure you want to delete profile "${name}"?`)) return;
    setDeletingId(id);
    try {
      await api.deleteOrchestrationProfile(id);
      toast.success(`Profile "${name}" deleted`);
      await loadData();
    } catch (err) {
      toast.error(`Failed to delete profile: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const updateRoleField = (roleKey, field, val) => {
    setEditingProfile((prev) => {
      const currentRole = prev.profile[roleKey] || {};
      let updatedRole = { ...currentRole, [field]: val };

      if (field === 'provider') {
        updatedRole.model = '';
        updatedRole.effort = '';
      } else if (field === 'model') {
        const prov = providers.find((p) => p.id === currentRole.provider);
        updatedRole.effort = effortSurvivingModel(prov, val, currentRole.effort);
      }

      return {
        ...prev,
        profile: {
          ...prev.profile,
          [roleKey]: updatedRole,
        },
      };
    });
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Cpu className="text-port-accent" size={24} />
            Orchestration Profiles
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Configure multi-role execution with per-role provider, model, and reasoning effort
            for the Architect, Implementer, and Reviewer. Machine-local and opt-in per task.
          </p>
        </div>
        {!editingProfile && (
          <button
            onClick={handleStartCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm font-medium transition-colors self-start sm:self-auto"
          >
            <Plus size={16} />
            New Profile
          </button>
        )}
      </div>

      {editingProfile ? (
        <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-port-border pb-4">
            <h3 className="text-lg font-medium text-white">
              {isNew ? 'Create Orchestration Profile' : `Edit "${editingProfile.name}"`}
            </h3>
            <button
              onClick={handleCancelEdit}
              aria-label="Close"
              className="text-gray-400 hover:text-white p-2 rounded-lg transition-colors min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
            >
              <X size={20} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="Profile Name" hint="Human-readable label for task pickers">
              <input
                type="text"
                value={editingProfile.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setEditingProfile((p) => ({
                    ...p,
                    name,
                    id: isNew && (!p.id || p.id === p.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-'))
                      ? name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-')
                      : p.id,
                  }));
                }}
                placeholder="e.g. Heavy Planner / Fast Implementer"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
            </FormField>

            <FormField label="Profile ID" hint="Unique machine-local identifier">
              <input
                type="text"
                value={editingProfile.id}
                disabled={!isNew}
                onChange={(e) => setEditingProfile((p) => ({ ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') }))}
                placeholder="e.g. heavy-planner"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm disabled:opacity-50"
              />
            </FormField>
          </div>

          <FormField label="Description" hint="Optional summary of this profile's strategy">
            <textarea
              value={editingProfile.description}
              onChange={(e) => setEditingProfile((p) => ({ ...p, description: e.target.value }))}
              placeholder="e.g. Uses a reasoning-heavy architect for task planning and a fast model for mechanical edits."
              rows={2}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm resize-none"
            />
          </FormField>

          <div className="space-y-4 pt-2">
            <h4 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
              Role Assignments
            </h4>
            <div className="grid grid-cols-1 gap-4">
              {ROLES.map(({ key, label, description }) => {
                const roleData = editingProfile.profile[key] || {};
                const selectedProv = providers.find((p) => p.id === roleData.provider);
                const models = selectedProv ? effortAwareModelOptions(selectedProv, roleData.model) : [];

                return (
                  <div key={key} className="bg-port-bg/50 border border-port-border/80 rounded-xl p-4 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                      <span className="font-medium text-white flex items-center gap-2">
                        <Sparkles size={14} className="text-port-accent" />
                        {label} Role
                      </span>
                      <span className="text-xs text-gray-400">{description}</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label htmlFor={`role-${key}-provider`} className="text-xs text-gray-400 mb-1 block">Provider</label>
                        <select
                          id={`role-${key}-provider`}
                          aria-label={`${label} Provider`}
                          value={roleData.provider || ''}
                          onChange={(e) => updateRoleField(key, 'provider', e.target.value)}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                        >
                          <option value="">Default (Auto / Inherit)</option>
                          {providers.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor={`role-${key}-model`} className="text-xs text-gray-400 mb-1 block">Model</label>
                        <select
                          id={`role-${key}-model`}
                          aria-label={`${label} Model`}
                          value={roleData.model || ''}
                          disabled={!selectedProv || models.length === 0}
                          onChange={(e) => updateRoleField(key, 'model', e.target.value)}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm disabled:opacity-50"
                        >
                          <option value="">Default (Provider default)</option>
                          {models.map((m) => (
                            <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor={`role-${key}-effort`} className="text-xs text-gray-400 mb-1 block">Reasoning Effort</label>
                        <select
                          id={`role-${key}-effort`}
                          aria-label={`${label} Reasoning Effort`}
                          value={roleData.effort || ''}
                          onChange={(e) => updateRoleField(key, 'effort', e.target.value)}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                        >
                          <option value="">Default (Inherit / Task)</option>
                          {GENERAL_EFFORTS.map((eff) => (
                            <option key={eff} value={eff}>{eff}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-port-border">
            <button
              onClick={handleCancelEdit}
              disabled={saving}
              className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-sm transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              <Check size={16} />
              {saving ? 'Saving…' : 'Save Profile'}
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="p-8 text-center text-gray-400">Loading orchestration profiles…</div>
      ) : profiles.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-8 text-center space-y-3">
          <p className="text-gray-400">No orchestration profiles configured.</p>
          <button
            onClick={handleStartCreate}
            className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Create your first profile
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {profiles.map((p) => {
            const isDeleting = deletingId === p.id;
            return (
              <div
                key={p.id}
                className="bg-port-card border border-port-border rounded-xl p-5 space-y-4 hover:border-port-border/80 transition-colors"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white text-base">{p.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-port-border text-gray-300 font-mono">
                        {p.id}
                      </span>
                      {p.isBuiltin && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-port-accent/20 text-port-accent border border-port-accent/30 flex items-center gap-1">
                          <Shield size={10} /> Built-in
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <p className="text-sm text-gray-400">{p.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <button
                      onClick={() => handleStartEdit(p)}
                      className="p-2 hover:bg-port-border rounded-lg text-gray-300 hover:text-white transition-colors min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
                      title="Edit profile"
                      aria-label={`Edit profile ${p.name}`}
                    >
                      <Edit2 size={16} />
                    </button>
                    {!p.isBuiltin && (
                      <button
                        onClick={() => handleDelete(p.id, p.name)}
                        disabled={isDeleting}
                        className="p-2 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded-lg transition-colors disabled:opacity-50 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
                        title="Delete profile"
                        aria-label={`Delete profile ${p.name}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-port-border/50 text-sm">
                  {ROLES.map(({ key, label }) => {
                    const r = p.profile?.[key];
                    const prov = r?.provider ? (providers.find((x) => x.id === r.provider)?.name || r.provider) : 'Default';
                    const mod = r?.model || 'Default';
                    const eff = r?.effort || 'Default';

                    return (
                      <div key={key} className="bg-port-bg/40 rounded-lg p-3 space-y-1.5 border border-port-border/40">
                        <div className="text-xs font-semibold text-port-accent uppercase tracking-wider">
                          {label}
                        </div>
                        <div className="text-xs text-gray-300">
                          <span className="text-gray-500">Provider: </span>
                          <span className="font-medium text-white">{prov}</span>
                        </div>
                        <div className="text-xs text-gray-300 truncate">
                          <span className="text-gray-500">Model: </span>
                          <span className="font-medium text-white">{mod}</span>
                        </div>
                        <div className="text-xs text-gray-300">
                          <span className="text-gray-500">Effort: </span>
                          <span className="font-medium text-white">{eff}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import {
  RefreshCw,
  Plus,
  Edit2,
  Trash2,
  X,
  Save,
  ChevronDown,
  ChevronRight,
  CheckCircle2
} from 'lucide-react';
import toast from 'react-hot-toast';

import {
  MEMORY_TABS,
  DESTINATIONS,
  PROJECT_STATUS_COLORS,
  IDEA_STATUS_COLORS,
  ADMIN_STATUS_COLORS,
  formatRelativeTime
} from '../constants';

export default function MemoryTab({ onRefresh }) {
  const [activeType, setActiveType] = useState('people');
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({});
  const [statusFilter, setStatusFilter] = useState('');

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    let data = [];

    const filters = statusFilter ? { status: statusFilter } : undefined;

    switch (activeType) {
      case 'people':
        data = await api.getBrainPeople().catch(() => []);
        break;
      case 'projects':
        data = await api.getBrainProjects(filters).catch(() => []);
        break;
      case 'ideas':
        data = await api.getBrainIdeas(filters).catch(() => []);
        break;
      case 'admin':
        data = await api.getBrainAdmin(filters).catch(() => []);
        break;
    }

    // Filter out archived records
    data = data.filter(r => !r.archived);
    setRecords(data);
    setLoading(false);
  }, [activeType, statusFilter]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const handleSave = async () => {
    let result;
    switch (activeType) {
      case 'people':
        result = await api.updateBrainPerson(editingId, editForm).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'projects':
        result = await api.updateBrainProject(editingId, editForm).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'ideas':
        result = await api.updateBrainIdea(editingId, editForm).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'admin':
        result = await api.updateBrainAdminItem(editingId, editForm).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
    }

    if (result) {
      toast.success('Saved');
      setEditingId(null);
      setEditForm({});
      fetchRecords();
      onRefresh?.();
    }
  };

  const handleAdd = async () => {
    let result;
    switch (activeType) {
      case 'people':
        result = await api.createBrainPerson(addForm).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'projects':
        result = await api.createBrainProject({ ...addForm, status: addForm.status || 'active' }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'ideas':
        result = await api.createBrainIdea(addForm).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'admin':
        result = await api.createBrainAdminItem({ ...addForm, status: addForm.status || 'open' }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
    }

    if (result) {
      toast.success('Created');
      setShowAdd(false);
      setAddForm({});
      fetchRecords();
      onRefresh?.();
    }
  };

  const handleDelete = async (id) => {
    let failed = false;
    switch (activeType) {
      case 'people':
        await api.deleteBrainPerson(id).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
      case 'projects':
        await api.deleteBrainProject(id).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
      case 'ideas':
        await api.deleteBrainIdea(id).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
      case 'admin':
        await api.deleteBrainAdminItem(id).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
    }

    if (!failed) {
      toast.success('Deleted');
      fetchRecords();
      onRefresh?.();
    }
  };

  const handleMarkDone = async (record) => {
    let result;
    const update = { status: 'done' };
    switch (activeType) {
      case 'projects':
        result = await api.updateBrainProject(record.id, update).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'ideas':
        result = await api.updateBrainIdea(record.id, update).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'admin':
        result = await api.updateBrainAdminItem(record.id, update).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
    }
    if (result) {
      toast.success('Marked as done');
      fetchRecords();
      onRefresh?.();
    }
  };

  const startEdit = (record) => {
    setEditingId(record.id);
    setEditForm({ ...record });
  };

  const renderForm = (form, setForm, isEdit = false) => {
    switch (activeType) {
      case 'people':
        return (
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Name"
              value={form.name || ''}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
            <textarea
              placeholder="Context (who they are, how you know them)"
              value={form.context || ''}
              onChange={(e) => setForm({ ...form, context: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              rows={2}
            />
            <input
              type="text"
              placeholder="Follow-ups (comma separated)"
              value={(form.followUps || []).join(', ')}
              onChange={(e) => setForm({ ...form, followUps: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
          </div>
        );

      case 'projects':
        return (
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Project name"
              value={form.name || ''}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
            <select
              value={form.status || 'active'}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              <option value="active">Active</option>
              <option value="waiting">Waiting</option>
              <option value="blocked">Blocked</option>
              <option value="someday">Someday</option>
              <option value="done">Done</option>
            </select>
            <input
              type="text"
              placeholder="Next action (concrete, actionable step)"
              value={form.nextAction || ''}
              onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
            <textarea
              placeholder="Notes"
              value={form.notes || ''}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              rows={2}
            />
          </div>
        );

      case 'ideas':
        return (
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Title"
              value={form.title || ''}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
            <select
              value={form.status || 'active'}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              <option value="active">Active</option>
              <option value="done">Done</option>
            </select>
            <input
              type="text"
              placeholder="One-liner (core insight)"
              value={form.oneLiner || ''}
              onChange={(e) => setForm({ ...form, oneLiner: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
            <textarea
              placeholder="Notes"
              value={form.notes || ''}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              rows={2}
            />
          </div>
        );

      case 'admin':
        return (
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Title"
              value={form.title || ''}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
            <select
              value={form.status || 'open'}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              <option value="open">Open</option>
              <option value="waiting">Waiting</option>
              <option value="done">Done</option>
            </select>
            <input
              type="date"
              placeholder="Due date"
              value={form.dueDate ? form.dueDate.split('T')[0] : ''}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
            <input
              type="text"
              placeholder="Next action"
              value={form.nextAction || ''}
              onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            />
          </div>
        );
    }
  };

  const renderRecord = (record) => {
    if (editingId === record.id) {
      return (
        <div key={record.id} className="p-4 bg-port-card border border-port-accent/50 rounded-lg">
          {renderForm(editForm, setEditForm, true)}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleSave}
              className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30"
            >
              <Save size={14} />
              Save
            </button>
            <button
              onClick={() => { setEditingId(null); setEditForm({}); }}
              className="px-3 py-1.5 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    return (
      <div key={record.id} className="p-4 bg-port-card border border-port-border rounded-lg hover:border-port-border/80 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            {activeType === 'people' && (
              <>
                <h3 className="font-medium text-white">{record.name}</h3>
                {record.context && <p className="text-sm text-gray-400 mt-1">{record.context}</p>}
                {record.followUps?.length > 0 && (
                  <div className="mt-2">
                    <span className="text-xs text-gray-500">Follow-ups:</span>
                    <ul className="list-disc list-inside text-sm text-gray-400">
                      {record.followUps.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}

            {activeType === 'projects' && (
              <>
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-white">{record.name}</h3>
                  <span className={`px-2 py-0.5 text-xs rounded border ${PROJECT_STATUS_COLORS[record.status]}`}>
                    {record.status}
                  </span>
                </div>
                <p className="text-sm text-port-accent mt-1">Next: {record.nextAction}</p>
                {record.notes && <p className="text-sm text-gray-400 mt-1">{record.notes}</p>}
              </>
            )}

            {activeType === 'ideas' && (
              <>
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-white">{record.title}</h3>
                  <span className={`px-2 py-0.5 text-xs rounded border ${IDEA_STATUS_COLORS[record.status || 'active']}`}>
                    {record.status || 'active'}
                  </span>
                </div>
                <p className="text-sm text-yellow-400 mt-1">{record.oneLiner}</p>
                {record.notes && <p className="text-sm text-gray-400 mt-1">{record.notes}</p>}
              </>
            )}

            {activeType === 'admin' && (
              <>
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-white">{record.title}</h3>
                  <span className={`px-2 py-0.5 text-xs rounded border ${ADMIN_STATUS_COLORS[record.status]}`}>
                    {record.status}
                  </span>
                </div>
                {record.dueDate && (
                  <p className="text-sm text-port-warning mt-1">
                    Due: {new Date(record.dueDate).toLocaleDateString()}
                  </p>
                )}
                {record.nextAction && <p className="text-sm text-gray-400 mt-1">Next: {record.nextAction}</p>}
              </>
            )}

            <p className="text-xs text-gray-500 mt-2">
              Updated {formatRelativeTime(record.updatedAt)}
            </p>
          </div>

          <div className="flex items-center gap-1">
            {(activeType === 'projects' || activeType === 'ideas' || activeType === 'admin') && record.status !== 'done' && (
              <button
                onClick={() => handleMarkDone(record)}
                className="p-1.5 text-gray-400 hover:text-port-success rounded hover:bg-port-success/20"
                title="Mark done"
              >
                <CheckCircle2 size={14} />
              </button>
            )}
            <button
              onClick={() => startEdit(record)}
              className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-port-border/50"
              title="Edit"
            >
              <Edit2 size={14} />
            </button>
            <button
              onClick={() => handleDelete(record.id)}
              className="p-1.5 text-gray-400 hover:text-port-error rounded hover:bg-port-error/20"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Type tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {MEMORY_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeType === tab.id;
          const destInfo = DESTINATIONS[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => { setActiveType(tab.id); setStatusFilter(''); }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? `${destInfo.color}`
                  : 'bg-port-card text-gray-400 hover:text-white'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}

        {/* Add button */}
        <button
          onClick={() => { setShowAdd(true); setAddForm({}); }}
          className="flex items-center gap-1 px-3 py-2 bg-port-accent/20 text-port-accent rounded-lg text-sm hover:bg-port-accent/30"
        >
          <Plus size={16} />
          Add
        </button>

        {/* Status filter for projects/ideas/admin */}
        {(activeType === 'projects' || activeType === 'ideas' || activeType === 'admin') && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-white"
          >
            <option value="">All statuses</option>
            {activeType === 'projects' ? (
              <>
                <option value="active">Active</option>
                <option value="waiting">Waiting</option>
                <option value="blocked">Blocked</option>
                <option value="someday">Someday</option>
                <option value="done">Done</option>
              </>
            ) : activeType === 'ideas' ? (
              <>
                <option value="active">Active</option>
                <option value="done">Done</option>
              </>
            ) : (
              <>
                <option value="open">Open</option>
                <option value="waiting">Waiting</option>
                <option value="done">Done</option>
              </>
            )}
          </select>
        )}
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="p-4 bg-port-card border border-port-accent/50 rounded-lg">
          <h3 className="font-medium text-white mb-3">Add {DESTINATIONS[activeType].label}</h3>
          {renderForm(addForm, setAddForm)}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleAdd}
              className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30"
            >
              <Plus size={14} />
              Create
            </button>
            <button
              onClick={() => { setShowAdd(false); setAddForm({}); }}
              className="px-3 py-1.5 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Records list */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
        </div>
      ) : records.length === 0 ? (
        <p className="text-gray-500 text-center py-8">
          No {DESTINATIONS[activeType].label.toLowerCase()} yet. Add one or capture thoughts in the Inbox.
        </p>
      ) : (
        <div className="space-y-2">
          {records.map(record => renderRecord(record))}
        </div>
      )}
    </div>
  );
}

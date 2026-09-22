import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router';
import * as api from '../../../services/api';
import {Plus,
  Edit2,
  Trash2,
  X,
  Save,
  CheckCircle2,
  Search,
  AlertTriangle,
  Library,
  MessageSquareText} from 'lucide-react';
import toast from '../../ui/Toast';
import Banner from '../../ui/Banner';
import { FormField } from '../../ui/FormField';
import ConversationViewer from '../ConversationViewer';
import MemoryImagePreview from '../MemoryImagePreview';

import {
  MEMORY_TABS,
  DESTINATIONS,
  PROJECT_STATUS_COLORS,
  IDEA_STATUS_COLORS,
  ADMIN_STATUS_COLORS
} from '../constants';
import { timeAgo, formatDateNumeric } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import CopyableId from '../../ui/CopyableId';
import CollapsibleListItem from '../../ui/CollapsibleListItem';
import InfiniteScrollFooter from '../../ui/InfiniteScrollFooter';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import { usePagedCollection } from '../../../hooks/usePagedCollection';
import socket from '../../../services/socket';

// Plain-text teaser for imported transcripts — avoids mounting full markdown
// for every card. The full thread is one click away via ConversationViewer.
export function transcriptTeaser(content, maxLen = 220) {
  if (typeof content !== 'string' || !content) return '';
  const plain = content
    .replace(/!\[[^\]]*]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1') // links → label
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen).trimEnd()}…`;
}

// Ideas is a first-class Brain route, but it deliberately shares this native
// record surface so CRUD, status completion, catalog handoff, embeddings, and
// federation continue to use the same idea model and API.
export default function MemoryTab({ onRefresh, fixedType = null }) {
  const navigate = useNavigate();
  const { recordType, recordId } = useParams();
  const location = useLocation();
  const basePath = fixedType ? '/brain/ideas' : '/brain/memory';
  const closeReader = () => navigate(basePath + location.search);
  const [activeType, setActiveType] = useState(fixedType || recordType || 'memories');
  const [removingIds, setRemovingIds] = useState(new Set());
  const [deletedIds, setDeletedIds] = useState(() => new Set());
  const pendingDeletes = useRef(new Set());
  const deletedIdsRef = useRef(new Set());
  const currentType = useRef(activeType);
  currentType.current = activeType;
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({});
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [backendStatus, setBackendStatus] = useState(null);
  const [deepLinkedRecord, setDeepLinkedRecord] = useState(null);
  const { isConfirming, requestDelete, cancelDelete } = useConfirmDelete();

  useEffect(() => {
    if (recordType && MEMORY_TABS.some(tab => tab.id === recordType)) setActiveType(recordType);
  }, [recordType]);

  useEffect(() => {
    if (fixedType) setActiveType(fixedType);
  }, [fixedType]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim());
    }, 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchPage = useCallback(async ({ cursor, signal }) => {
    let res;
    const options = {
      cursor,
      search: debouncedSearch || undefined,
      status: statusFilter || undefined,
      limit: 25,
      signal
    };

    switch (activeType) {
      case 'people':
        res = await api.getBrainPeople(options).catch(() => ({ items: [] }));
        break;
      case 'projects':
        res = await api.getBrainProjects(options).catch(() => ({ items: [] }));
        break;
      case 'ideas':
        res = await api.getBrainIdeas(options).catch(() => ({ items: [] }));
        break;
      case 'admin':
        res = await api.getBrainAdmin(options).catch(() => ({ items: [] }));
        break;
      case 'memories':
      default:
        res = await api.getBrainMemories(options).catch(() => ({ items: [] }));
        break;
    }

    const items = Array.isArray(res) ? res : (res.items || res[activeType] || []);
    const unarchived = items.filter(r => !r.archived && !deletedIdsRef.current.has(r.id));
    return {
      items: unarchived,
      total: res.total ?? unarchived.length,
      nextCursor: res.nextCursor ?? null
    };
  }, [activeType, debouncedSearch, statusFilter]);

  const paged = usePagedCollection(fetchPage);

  const records = useMemo(() => {
    return paged.items.filter(r => !deletedIds.has(r.id) && !deletedIdsRef.current.has(r.id));
  }, [paged.items, deletedIds]);

  // Reconnect reconciliation: recover missed events
  useEffect(() => {
    const handleConnect = () => {
      paged.refreshFirst();
    };
    socket.on('connect', handleConnect);
    return () => socket.off('connect', handleConnect);
  }, [paged.refreshFirst]);

  // Direct URL deep-link or truncated record detail fetch
  useEffect(() => {
    if (!recordId) {
      setDeepLinkedRecord(null);
      return;
    }
    const existing = records.find(r => r.id === recordId);
    if (!existing || existing.contentTruncated) {
      let active = true;
      const fetchRecord = async () => {
        let full = null;
        switch (activeType) {
          case 'people':
            full = await api.getBrainPerson(recordId).catch(() => null);
            break;
          case 'projects':
            full = await api.getBrainProject(recordId).catch(() => null);
            break;
          case 'ideas':
            full = await api.getBrainIdea(recordId).catch(() => null);
            break;
          case 'admin':
            full = await api.getBrainAdminItem(recordId).catch(() => null);
            break;
          case 'memories':
          default:
            full = await api.getBrainMemory(recordId).catch(() => null);
            break;
        }
        if (active) {
          if (full && !full.archived && !deletedIdsRef.current.has(full.id)) {
            setDeepLinkedRecord(full);
          } else {
            setDeepLinkedRecord(null);
          }
        }
      };
      fetchRecord();
      return () => { active = false; };
    } else {
      setDeepLinkedRecord(null);
    }
  }, [recordId, activeType, records]);

  const viewerRecord = useMemo(() => {
    if (!recordId) return null;
    const existing = records.find(r => r.id === recordId);
    if (deepLinkedRecord && deepLinkedRecord.id === recordId) {
      return deepLinkedRecord;
    }
    return existing || null;
  }, [recordId, records, deepLinkedRecord]);

  const fetchBackendStatus = useCallback(() => {
    api.getMemoryBackendStatus().then(setBackendStatus).catch(() => null);
  }, []);

  useEffect(() => {
    fetchBackendStatus();
  }, [fetchBackendStatus]);

  const loading = !paged.loaded && paged.loading;

  const filteredRecords = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return records;
    return records.filter((r) => {
      if (removingIds.has(`${activeType}:${r.id}`)) return true;
      const fields = [
        r.name, r.title, r.context, r.content, r.notes, r.oneLiner,
        r.nextAction, r.mood, ...(r.tags || []), ...(r.followUps || []),
      ];
      return fields.some((f) => f?.toLowerCase().includes(q));
    });
  }, [records, searchQuery, removingIds, activeType]);

  const handleSave = async () => {
    let result;
    switch (activeType) {
      case 'people':
        result = await api.updateBrainPerson(editingId, editForm, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'projects':
        result = await api.updateBrainProject(editingId, editForm, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'ideas':
        result = await api.updateBrainIdea(editingId, editForm, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'admin':
        result = await api.updateBrainAdminItem(editingId, editForm, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'memories': {
        const { tagInput, ...memData } = editForm;
        if (tagInput != null) memData.tags = tagInput.split(',').map(s => s.trim()).filter(Boolean);
        result = await api.updateBrainMemory(editingId, memData, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      }
    }

    if (result) {
      toast.success('Saved');
      setEditingId(null);
      setEditForm({});
      paged.refreshFirst();
      onRefresh?.();
    }
  };

  const handleAdd = async () => {
    let result;
    switch (activeType) {
      case 'people':
        result = await api.createBrainPerson(addForm, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'projects':
        result = await api.createBrainProject({ ...addForm, status: addForm.status || 'active' }, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'ideas':
        result = await api.createBrainIdea(addForm, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'admin':
        result = await api.createBrainAdminItem({ ...addForm, status: addForm.status || 'open' }, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'memories': {
        const { tagInput, ...memData } = addForm;
        if (tagInput != null) memData.tags = tagInput.split(',').map(s => s.trim()).filter(Boolean);
        result = await api.createBrainMemory(memData, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      }
    }

    if (result) {
      toast.success('Created');
      setShowAdd(false);
      setAddForm({});
      paged.refreshFirst();
      onRefresh?.();
    }
  };

  const handleDelete = async (id) => {
    const key = `${activeType}:${id}`;
    if (pendingDeletes.current.has(key)) return;
    pendingDeletes.current.add(key);
    let failed = false;
    switch (activeType) {
      case 'people':
        await api.deleteBrainPerson(id, { silent: true }).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
      case 'projects':
        await api.deleteBrainProject(id, { silent: true }).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
      case 'ideas':
        await api.deleteBrainIdea(id, { silent: true }).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
      case 'admin':
        await api.deleteBrainAdminItem(id, { silent: true }).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
      case 'memories':
        await api.deleteBrainMemory(id, { silent: true }).catch(err => {
          toast.error(err.message);
          failed = true;
        });
        break;
    }

    pendingDeletes.current.delete(key);
    if (!failed && currentType.current === activeType) {
      toast.success('Deleted');
      if (recordId === id) closeReader();
      setRemovingIds(previous => new Set(previous).add(key));
      onRefresh?.();
    }
  };

  const handleMarkDone = async (record) => {
    let result;
    const update = { status: 'done' };
    switch (activeType) {
      case 'projects':
        result = await api.updateBrainProject(record.id, update, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'ideas':
        result = await api.updateBrainIdea(record.id, update, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
      case 'admin':
        result = await api.updateBrainAdminItem(record.id, update, { silent: true }).catch(err => {
          toast.error(err.message);
          return null;
        });
        break;
    }
    if (result) {
      toast.success('Marked as done');
      paged.refreshFirst();
      onRefresh?.();
    }
  };

  // Send a brain record into the creative catalog. We hand the ids to the
  // catalog ingest page (via router state) so the LLM extraction + live stage
  // checklist run there — the brain note becomes typed catalog ingredients the
  // user reviews and commits. Every MEMORY_TABS type is a supported bridge type.
  const handleSendToCatalog = (record) => {
    // Hand off just the ids — the catalog resolves the record and derives its
    // title/text server-side via the brain-bridge ingest.
    navigate('/catalog/ingest', {
      state: { brainIngest: { brainType: activeType, brainId: record.id } },
    });
  };

  const startEdit = async (record) => {
    setEditingId(record.id);
    if (activeType === 'memories' && record.contentTruncated) {
      setEditForm({ ...record, tagInput: (record.tags || []).join(', ') });
      const full = await api.getBrainMemory(record.id).catch(() => null);
      if (full) {
        setEditForm({ ...full, tagInput: (full.tags || []).join(', ') });
      }
    } else {
      setEditForm({ ...record, tagInput: (record.tags || []).join(', ') });
    }
  };

  const renderForm = (form, setForm, _isEdit = false) => {
    switch (activeType) {
      case 'people':
        return (
          <div className="space-y-3">
            <FormField label="Name" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Name"
                value={form.name || ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Context" labelClassName="block text-xs text-gray-400 mb-1">
              <textarea
                placeholder="Context (who they are, how you know them)"
                value={form.context || ''}
                onChange={(e) => setForm({ ...form, context: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                rows={2}
              />
            </FormField>
            <FormField label="Follow-ups" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Follow-ups (comma separated)"
                value={(form.followUps || []).join(', ')}
                onChange={(e) => setForm({ ...form, followUps: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
          </div>
        );

      case 'projects':
        return (
          <div className="space-y-3">
            <FormField label="Project name" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Project name"
                value={form.name || ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Status" labelClassName="block text-xs text-gray-400 mb-1">
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
            </FormField>
            <FormField label="Next action" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Next action (concrete, actionable step)"
                value={form.nextAction || ''}
                onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Notes" labelClassName="block text-xs text-gray-400 mb-1">
              <textarea
                placeholder="Notes"
                value={form.notes || ''}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                rows={2}
              />
            </FormField>
          </div>
        );

      case 'ideas':
        return (
          <div className="space-y-3">
            <FormField label="Title" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Title"
                value={form.title || ''}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Status" labelClassName="block text-xs text-gray-400 mb-1">
              <select
                value={form.status || 'active'}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                <option value="active">Active</option>
                <option value="done">Done</option>
              </select>
            </FormField>
            <FormField label="One-liner" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="One-liner (core insight)"
                value={form.oneLiner || ''}
                onChange={(e) => setForm({ ...form, oneLiner: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Notes" labelClassName="block text-xs text-gray-400 mb-1">
              <textarea
                placeholder="Notes"
                value={form.notes || ''}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                rows={2}
              />
            </FormField>
          </div>
        );

      case 'admin':
        return (
          <div className="space-y-3">
            <FormField label="Title" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Title"
                value={form.title || ''}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Status" labelClassName="block text-xs text-gray-400 mb-1">
              <select
                value={form.status || 'open'}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                <option value="open">Open</option>
                <option value="waiting">Waiting</option>
                <option value="done">Done</option>
              </select>
            </FormField>
            <FormField label="Due date" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="date"
                placeholder="Due date"
                value={form.dueDate ? form.dueDate.split('T')[0] : ''}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Next action" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Next action"
                value={form.nextAction || ''}
                onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
          </div>
        );

      case 'memories':
        return (
          <div className="space-y-3">
            <FormField label="Title" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Title (e.g. 'DnD session tonight')"
                value={form.title || ''}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="What happened" labelClassName="block text-xs text-gray-400 mb-1">
              <textarea
                placeholder="What happened? Write your thoughts..."
                value={form.content || ''}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                rows={3}
              />
            </FormField>
            <FormField label="Mood" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Mood (e.g. happy, reflective, tired)"
                value={form.mood || ''}
                onChange={(e) => setForm({ ...form, mood: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Tags" labelClassName="block text-xs text-gray-400 mb-1">
              <input
                type="text"
                placeholder="Tags (comma separated)"
                value={form.tagInput ?? (form.tags || []).join(', ')}
                onChange={(e) => setForm({ ...form, tagInput: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
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

    const isSelected = recordId === record.id;
    return (
      <div
        key={record.id}
        className={`p-4 bg-port-card rounded-lg transition-colors ${
          isSelected
            ? 'border-2 border-port-accent ring-1 ring-port-accent/30 bg-port-card/90 shadow-sm'
            : 'border border-port-border hover:border-port-border/80'
        }`}
      >
        <div className="flex flex-col sm:flex-row items-start justify-between gap-2">
          {/* min-w-0: without it a flex child won't shrink below its content's
              intrinsic width, so a long unbreakable code block in an imported
              transcript blows the row out and shoves the action buttons off
              the page. */}
          <div className="flex-1 min-w-0 w-full">
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
                    Due: {formatDateNumeric(record.dueDate)}
                  </p>
                )}
                {record.nextAction && <p className="text-sm text-gray-400 mt-1">Next: {record.nextAction}</p>}
              </>
            )}

            {activeType === 'memories' && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-medium text-white"><button className="text-left hover:text-port-accent" onClick={() => navigate(`${basePath}/memories/${encodeURIComponent(record.id)}${location.search}`)}>{record.title}</button></h3>
                  {record.mood && (
                    <span className="px-2 py-0.5 text-xs rounded border bg-pink-500/20 text-pink-400 border-pink-500/30">
                      {record.mood}
                    </span>
                  )}
                  {isSelected && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase rounded bg-port-accent/20 text-port-accent border border-port-accent/30">
                      Viewing
                    </span>
                  )}
                </div>
                <button
                  onClick={() => navigate(`${basePath}/memories/${encodeURIComponent(record.id)}${location.search}`)}
                  className="mt-1 w-full text-left rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-port-accent"
                  aria-label={`Read ${record.title || 'memory'}`}
                >
                  <span className="block text-sm text-gray-400 line-clamp-3 break-words">{transcriptTeaser(record.content)}</span>
                  <MemoryImagePreview record={record} />
                  <span className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-xs text-port-accent">
                    <MessageSquareText size={13} aria-hidden="true" /> Read full entry
                  </span>
                </button>
                {record.tags?.length > 0 && (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {record.tags.map((tag, i) => (
                      <span key={i} className="px-2 py-0.5 text-xs rounded bg-port-border/50 text-gray-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <p className="text-xs text-gray-500">
                {activeType === 'memories' && record.source === 'chatgpt-import' && (record.sourceUpdatedAt || record.sourceCreatedAt)
                  // Imported entries all share the bulk-import updatedAt, so show the
                  // original conversation recency instead (matches the list sort order) —
                  // but only when a source clock exists; a clockless import falls back to
                  // the honest "Updated {import time}" rather than mislabeling it.
                  ? `Conversation ${timeAgo(record.sourceUpdatedAt || record.sourceCreatedAt)}`
                  : `Updated ${timeAgo(record.updatedAt)}`}
              </p>
              <CopyableId id={record.id} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(activeType === 'projects' || activeType === 'ideas' || activeType === 'admin') && record.status !== 'done' && (
              <button
                onClick={() => handleMarkDone(record)}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-port-success rounded hover:bg-port-success/20"
                title="Mark done" aria-label="Mark done"
              >
                <CheckCircle2 size={14} />
              </button>
            )}
            <button
              onClick={() => handleSendToCatalog(record)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-port-accent-2 rounded hover:bg-port-accent-2/20"
              title="Send to Catalog"
              aria-label="Send to Catalog"
            >
              <Library size={14} />
            </button>
            <button
              onClick={() => startEdit(record)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white rounded hover:bg-port-border/50"
              title="Edit" aria-label="Edit"
            >
              <Edit2 size={14} />
            </button>
            <button
              onClick={() => requestDelete(record.id)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-port-error rounded hover:bg-port-error/20"
              title="Delete" aria-label="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        {isConfirming(record.id) && (
          <InlineConfirmRow
            className="mt-3"
            question="Delete this entry? This cannot be undone."
            confirmTitle="Confirm delete"
            cancelTitle="Cancel delete"
            onConfirm={() => handleDelete(record.id)}
            onCancel={cancelDelete}
          />
        )}
      </div>
    );
  };

  return (
    <div className={fixedType ? 'space-y-4' : 'h-full min-h-0 flex flex-col gap-4 overflow-hidden p-3 sm:p-4'}>
      {/* Backend status banner */}
      {backendStatus?.backend === 'file' && (
        <Banner
          tone="warning"
          size="lg"
          icon={AlertTriangle}
          title="PostgreSQL unavailable — using file storage"
          actions={(
            <button
              onClick={fetchBackendStatus}
              className="px-3 py-1.5 text-sm bg-port-warning/20 text-port-warning hover:bg-port-warning/30 rounded-lg transition-colors"
            >
              Retry
            </button>
          )}
        >
          {backendStatus.db?.error && (
            <p className="text-sm text-gray-400 mt-1">{backendStatus.db.error}</p>
          )}
          <p className="text-sm text-gray-500 mt-1">Some PostgreSQL-only features like cross-instance sync and DB snapshots are unavailable.</p>
        </Banner>
      )}

      {/* Type tabs */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {!fixedType && MEMORY_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeType === tab.id;
          const destInfo = DESTINATIONS[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => { closeReader(); setActiveType(tab.id); setStatusFilter(''); setSearchQuery(''); }}
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
            aria-label="Filter by status"
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

      {/* Main content area: split into list + sidebar preview when an entry is active */}
      <div className={`flex flex-col lg:flex-row gap-4 ${fixedType ? 'items-start' : 'flex-1 min-h-0 overflow-hidden'}`}>
        {/* Left column: search, add form, records list */}
        <div role="region" aria-label="Memory entries" tabIndex={0} className={`flex-1 min-w-0 w-full space-y-4 ${fixedType ? '' : 'min-h-0 overflow-y-auto overscroll-contain'} ${recordId && !loading ? 'hidden lg:block' : 'block'}`}>
          {/* Search filter */}
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder={`Search ${DESTINATIONS[activeType]?.label?.toLowerCase() || 'records'}...`}
              aria-label={`Search ${DESTINATIONS[activeType]?.label?.toLowerCase() || 'records'}`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-white placeholder-gray-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
              >
                <X size={14} />
              </button>
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
              <BrailleSpinner text="Loading" />
            </div>
          ) : filteredRecords.length === 0 ? (
            <p className="text-gray-500 text-center py-8">
              {searchQuery
                ? `No matches for "${searchQuery}"`
                : `No ${DESTINATIONS[activeType]?.label?.toLowerCase() || 'records'} yet. Add one or capture thoughts in the Inbox.`}
            </p>
          ) : (
            <div>
              {filteredRecords.map(record => (
                <CollapsibleListItem key={`${activeType}:${record.id}`}
                  removing={removingIds.has(`${activeType}:${record.id}`)}
                  onExited={() => {
                    deletedIdsRef.current.add(record.id);
                    setDeletedIds(previous => new Set(previous).add(record.id));
                    setRemovingIds(previous => {
                      const next = new Set(previous);
                      next.delete(`${activeType}:${record.id}`);
                      return next;
                    });
                  }}>
                  {renderRecord(record)}
                </CollapsibleListItem>
              ))}
              <InfiniteScrollFooter
                hasMore={paged.hasMore}
                loading={paged.loading}
                error={paged.error}
                onLoadMore={paged.loadMore}
              />
            </div>
          )}
        </div>

        {/* Right column: Sidebar preview for full content */}
        {recordId && !loading && (
          <div className={`w-full lg:w-[480px] xl:w-[560px] 2xl:w-[640px] shrink-0 ${fixedType ? '' : 'h-full min-h-0 overflow-y-auto'}`}>
            {viewerRecord ? (
              <ConversationViewer
                key={viewerRecord.id}
                record={viewerRecord}
                fillHeight={!fixedType}
                onClose={closeReader}
                onEdit={startEdit}
                onSendToCatalog={handleSendToCatalog}
              />
            ) : (
              <aside
                aria-label="Preview not found"
                className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col w-full shadow-lg lg:sticky lg:top-4"
              >
                <Banner tone="warning" title="Entry not found">
                  This entry may have been deleted or archived.
                  <button onClick={closeReader} className="block min-h-[44px] text-port-accent hover:underline">
                    Back to entries
                  </button>
                </Banner>
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

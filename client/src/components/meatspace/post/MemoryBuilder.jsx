import { useState, useEffect } from 'react';
import { Brain, ChevronLeft, Plus, Trash2, BookOpen, Zap, FlaskConical, Eye, X, Save } from 'lucide-react';
import { getMemoryItems, createMemoryItem, deleteMemoryItem } from '../../../services/api';
import MemoryPractice from './MemoryPractice';
import ElementsSong from './ElementsSong';

const ITEM_TYPES = [
  { id: 'song', label: 'Song' },
  { id: 'poem', label: 'Poem' },
  { id: 'speech', label: 'Speech' },
  { id: 'sequence', label: 'Sequence' },
  { id: 'text', label: 'Text' },
];

export default function MemoryBuilder({ onBack, onNavigateElements }) {
  const [items, setItems] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [view, setView] = useState('list'); // list, practice, elements, create
  const [creating, setCreating] = useState(false);

  // Create form state
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState('text');
  const [newContent, setNewContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    const data = await getMemoryItems().catch(() => []);
    setItems(data || []);
  }

  function handleSelect(item) {
    if (item.id === 'elements-song' && onNavigateElements) {
      onNavigateElements(item);
      return;
    }
    setSelectedItem(item);
    if (item.id === 'elements-song') {
      setView('elements');
    } else {
      setView('practice');
    }
  }

  async function handleDelete(id) {
    await deleteMemoryItem(id);
    setItems(prev => prev.filter(i => i.id !== id));
  }

  function resetCreateForm() {
    setNewTitle('');
    setNewType('text');
    setNewContent('');
    setCreating(false);
  }

  async function handleCreate() {
    if (!newTitle.trim() || !newContent.trim()) return;
    setSaving(true);

    // Split content into lines, preserving blank lines for chunk detection
    const rawLines = newContent.split('\n');
    const lines = rawLines.map(text => ({ text }));

    const item = await createMemoryItem({
      title: newTitle.trim(),
      type: newType,
      lines,
    }).catch(() => null);

    setSaving(false);
    if (item) {
      setItems(prev => [...prev, item]);
      resetCreateForm();
    }
  }

  if (view === 'elements' && selectedItem) {
    return (
      <ElementsSong
        item={selectedItem}
        onBack={() => { setView('list'); setSelectedItem(null); loadItems(); }}
      />
    );
  }

  if (view === 'practice' && selectedItem) {
    return (
      <MemoryPractice
        item={selectedItem}
        onBack={() => { loadItems(); setView('list'); setSelectedItem(null); }}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <Brain size={24} className="text-emerald-400" />
          <h2 className="text-xl font-bold text-white">Memory Builder</h2>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            <Plus size={14} />
            Add Item
          </button>
        )}
      </div>

      <p className="text-gray-400 text-sm">
        Train your memory with songs, poems, speeches, and sequences. Track mastery and practice weak spots.
      </p>

      {/* Create Form */}
      {creating && (
        <div className="bg-port-card border border-port-accent/30 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-medium">Add Memory Item</h3>
            <button onClick={resetCreateForm} className="text-gray-500 hover:text-white transition-colors">
              <X size={16} />
            </button>
          </div>

          <div>
            <label className="block text-gray-400 text-xs mb-1.5">Title</label>
            <input
              type="text"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              placeholder="e.g. The Raven, Gettysburg Address, Pi digits..."
              maxLength={200}
              className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:border-port-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-gray-400 text-xs mb-1.5">Type</label>
            <div className="flex flex-wrap gap-2">
              {ITEM_TYPES.map(t => (
                <button
                  key={t.id}
                  onClick={() => setNewType(t.id)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                    newType === t.id
                      ? 'bg-port-accent/20 border-port-accent text-port-accent'
                      : 'bg-port-bg border-port-border text-gray-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-gray-400 text-xs mb-1.5">
              Content <span className="text-gray-600">(one line per row; blank lines create chunk boundaries)</span>
            </label>
            <textarea
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              placeholder={"Paste or type your content here.\nEach line becomes a learnable unit.\n\nBlank lines separate chunks/verses."}
              rows={12}
              className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:border-port-accent focus:outline-none resize-y font-mono leading-relaxed"
            />
            {newContent.trim() && (
              <ContentPreview content={newContent} />
            )}
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={resetCreateForm}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim() || !newContent.trim() || saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-port-success hover:bg-port-success/80 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save Item'}
            </button>
          </div>
        </div>
      )}

      {/* Memory Items */}
      <div className="space-y-3">
        {items.map(item => (
          <div
            key={item.id}
            className="bg-port-card border border-port-border rounded-lg p-4 hover:border-port-accent/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <ItemIcon type={item.type} builtin={item.builtin} />
                <div className="min-w-0">
                  <h3 className="text-white font-medium truncate">{item.title}</h3>
                  <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                    <span>{item.type}</span>
                    <span>{item.content?.lines?.length || 0} lines</span>
                    <span>{item.content?.chunks?.length || 0} chunks</span>
                    {item.builtin && <span className="text-emerald-500">built-in</span>}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <MasteryBadge pct={item.mastery?.overallPct || 0} />
                <button
                  onClick={() => handleSelect(item)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
                >
                  <BookOpen size={14} />
                  Practice
                </button>
                {!item.builtin && (
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="p-1.5 text-gray-500 hover:text-port-error transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}

        {items.length === 0 && (
          <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
            <Brain size={32} className="text-gray-600 mx-auto mb-3" />
            <p className="text-gray-500">No memory items yet. The Elements Song will be added automatically.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ContentPreview({ content }) {
  const rawLines = content.split('\n');
  const nonEmptyLines = rawLines.filter(l => l.trim().length > 0);

  // Count chunks (groups separated by blank lines)
  let chunkCount = 0;
  let inChunk = false;
  for (const line of rawLines) {
    if (line.trim()) {
      if (!inChunk) { chunkCount++; inChunk = true; }
    } else {
      inChunk = false;
    }
  }
  if (chunkCount < 2) chunkCount = Math.ceil(nonEmptyLines.length / 4);

  return (
    <div className="mt-2 flex gap-4 text-xs text-gray-500">
      <span>{nonEmptyLines.length} lines</span>
      <span>{chunkCount} chunks</span>
    </div>
  );
}

function ItemIcon({ type, builtin }) {
  if (builtin) return <FlaskConical size={20} className="text-emerald-400 shrink-0" />;
  switch (type) {
    case 'song': return <Zap size={20} className="text-purple-400 shrink-0" />;
    case 'poem': return <BookOpen size={20} className="text-blue-400 shrink-0" />;
    case 'speech': return <Eye size={20} className="text-amber-400 shrink-0" />;
    default: return <Brain size={20} className="text-gray-400 shrink-0" />;
  }
}

function MasteryBadge({ pct }) {
  const color = pct >= 80 ? 'text-port-success' : pct >= 40 ? 'text-port-warning' : 'text-gray-500';
  return (
    <div className={`text-sm font-mono font-medium ${color}`}>
      {pct}%
    </div>
  );
}

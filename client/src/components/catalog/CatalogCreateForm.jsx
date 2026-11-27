import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import ListLoadError from '../ui/ListLoadError';

export default function CatalogCreateForm({ form, setForm, types, getType, universesResource, creating, onCreate, onCancel, onBabble }) {
  const universeAvailable = universesResource.items.some((universe) => universe.id === form.universeId);
  return (
    <form onSubmit={onCreate} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg space-y-3">
      <div className="max-w-sm">
        <label htmlFor="catalog-new-universe" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Owning universe &amp; style</label>
        <select
          id="catalog-new-universe"
          required
          autoFocus={!form.universeId}
          value={form.universeId}
          onChange={(event) => setForm((previous) => ({ ...previous, universeId: event.target.value }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
        >
          <option value="">Choose a universe…</option>
          {universesResource.items.map((universe) => <option key={universe.id} value={universe.id}>{universe.name || '(untitled universe)'}</option>)}
        </select>
        {universesResource.state === 'error' && <ListLoadError what="owning universes" error={universesResource.error} onRetry={universesResource.retry} />}
        {universesResource.state === 'ready' && universesResource.items.length === 0 && <Link to="/universes/new" className="text-xs text-port-accent hover:underline">Create a universe</Link>}
      </div>
      <Link to="/catalog/ingest?mode=babble" onClick={onBabble}
        className="text-sm text-port-accent hover:underline">
        Babble and Prune — turn a brainstorm into multiple entries
      </Link>
      <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3">
        <div>
          <label htmlFor="catalog-new-type" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
            Type
          </label>
          <select
            id="catalog-new-type"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="catalog-new-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
            Name
          </label>
          <input
            id="catalog-new-name"
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Echo Saint"
            maxLength={200}
            autoFocus={Boolean(form.universeId)}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          />
        </div>
      </div>
      <div>
        <label htmlFor="catalog-new-content" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
          {getType(form.type)?.primaryContentLabel || 'Description'}
          <span className="normal-case text-gray-500"> (optional)</span>
        </label>
        <textarea
          id="catalog-new-content"
          rows={4}
          value={form.content}
          onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
          placeholder="Capture the idea here — you can flesh it out in the editor."
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 min-h-[40px] rounded-lg text-gray-400 hover:text-white text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={creating || !form.name.trim() || !universeAvailable}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {creating ? <Loader2 size={14} className="animate-spin" /> : null}
          Create
        </button>
      </div>
    </form>
  );
}

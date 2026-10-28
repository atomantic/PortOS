import { useEffect, useState } from 'react';
import { Loader2, Save, Sparkles } from 'lucide-react';
import Drawer from '../Drawer';
import MusicVideoLlmPicker from '../musicVideo/MusicVideoLlmPicker';
import SentPromptPanel from '../media/SentPromptPanel';
import toast from '../ui/Toast';
import { createCatalogIngredient, draftCatalogStoryMember, joinCatalogStory } from '../../services/api';
import { formatCount } from '../../utils/formatters';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';
import { STORY_DRAFT_LIMITS } from '../../../../server/lib/catalogStoryDraft.js';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const fieldClass = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm';
const labelClass = 'block text-[11px] text-gray-500 mb-0.5';
const PICK_KEY = 'portos.catalogStoryDraft.llm';
const EMPTY_PICK = { providerId: '', model: '', effort: '' };

const readPick = () => {
  const saved = safeReadJsonStorage(PICK_KEY, null);
  return saved && typeof saved === 'object' ? { ...EMPTY_PICK, ...saved } : EMPTY_PICK;
};

const storyKey = (story) => (story ? `${story.kind}:${story.id}` : '');

/**
 * New from prompt: the user's words go to the provider › model › effort they
 * pick, with the universe, the story and who is already in it as visible
 * blocks beside them. The draft comes back as an editable preview; saving
 * creates the record in the universe and joins it to the story.
 */
export default function StoryDraftDrawer({ open, onClose, library, typeMeta, universes, stories, initialUniverseId, initialStory, onSaved }) {
  const [universeId, setUniverseId] = useState(initialUniverseId || '');
  const initialStoryKey = initialStory?.joinable ? storyKey(initialStory) : '';
  const [storyChoice, setStoryChoice] = useState(initialStoryKey);
  const [prompt, setPrompt] = useState('');
  const [pick, setPick] = useState(readPick);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (!open) return;
    setUniverseId(initialUniverseId || '');
    setStoryChoice(initialStoryKey);
  }, [open, initialUniverseId, initialStoryKey]);

  const universeStories = stories.filter((story) => story.joinable && story.universeIds.includes(universeId));
  const story = universeStories.find((item) => storyKey(item) === storyChoice) || null;
  const over = prompt.length > STORY_DRAFT_LIMITS.prompt;

  const changePick = (next) => {
    setPick(next);
    safeWriteJsonStorage(PICK_KEY, next);
  };

  const draft = async () => {
    setRunning(true);
    const res = await draftCatalogStoryMember({
      type: library.type, universeId, prompt, ...pick,
      ...(story ? { storyKind: story.kind, storyId: story.id } : {}),
    }).catch(() => null);
    setRunning(false);
    if (res) setPreview({ ...res, name: res.draft.name, content: res.draft.content });
  };

  const save = async () => {
    const name = preview.name.trim();
    if (!name || !universeId) return;
    const content = preview.content.trim();
    const contentKey = typeMeta?.primaryContentKey || 'description';
    setSaving(true);
    const created = await createCatalogIngredient(
      { type: library.type, name, universeId, payload: content ? { [contentKey]: content } : {}, tags: [] },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || `Failed to create ${library.singular}`); return null; });
    const joined = created && story
      ? await joinCatalogStory(story.kind, story.id, created.id, { silent: true }).then(() => true)
        .catch((err) => { toast.error(`${name} was saved but could not join ${story.name}: ${err?.message || 'unknown error'}`); return false; })
      : true;
    setSaving(false);
    if (!created) return;
    if (joined) toast.success(story ? `${name} joined ${story.name}` : `${name} saved`);
    setPreview(null);
    setPrompt('');
    onSaved(created);
  };

  return (
    <Drawer open={open} onClose={onClose} title="New from prompt" subtitle={library.label} size="md" closeLabel="Close new from prompt">
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="story-draft-universe" className={labelClass}>Universe</label>
            <select id="story-draft-universe" value={universeId} onChange={(e) => { setUniverseId(e.target.value); setStoryChoice(''); }} className={fieldClass}>
              <option value="">Choose a universe…</option>
              {universes.map((universe) => <option key={universe.id} value={universe.id}>{universe.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="story-draft-story" className={labelClass}>Joins story</label>
            <select id="story-draft-story" value={storyChoice} onChange={(e) => setStoryChoice(e.target.value)} disabled={!universeId} className={fieldClass}>
              <option value="">No story</option>
              {universeStories.map((item) => <option key={storyKey(item)} value={storyKey(item)}>{item.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="story-draft-prompt" className={labelClass}>Describe the {library.singular}</label>
          <textarea id="story-draft-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5}
            placeholder={library.type === 'character' ? 'A night-shift mechanic who still skates, the lead’s older brother.' : 'In your own words.'}
            className={`${fieldClass} min-h-[7rem]`} />
          <p className={`text-[11px] tabular-nums ${over ? 'text-port-error' : 'text-gray-500'}`} {...(over ? { role: 'alert' } : {})}>
            {formatCount(prompt.length)} / {formatCount(STORY_DRAFT_LIMITS.prompt)} characters{over ? ': shorten it to send it' : ''}
          </p>
        </div>
        <MusicVideoLlmPicker idPrefix="story-draft" label="Model" value={pick} onChange={changePick}
          emptyProviderOption="Default (active provider)" fallbackName="The active provider" hint={null} />
        <button type="button" onClick={draft} disabled={running || !prompt.trim() || over || !universeId}
          className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>
          {running ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
          {running ? 'Drafting…' : 'Draft'}
        </button>
        {!universeId && <p className="text-xs text-gray-500">Pick the universe it belongs to first.</p>}

        {preview && (
          <div className="space-y-2 border-t border-port-border pt-3">
            <SentPromptPanel prompt={prompt} sentPrompt={preview.sentPrompt} additions={preview.promptAdditions} />
            <p className="text-xs text-gray-400">Draft from {preview.model || preview.providerId}. Edit anything before saving.</p>
            <div>
              <label htmlFor="story-draft-name" className={labelClass}>Name</label>
              <input id="story-draft-name" type="text" value={preview.name} maxLength={STORY_DRAFT_LIMITS.name}
                onChange={(e) => setPreview((p) => ({ ...p, name: e.target.value }))} className={fieldClass} />
            </div>
            <div>
              <label htmlFor="story-draft-content" className={labelClass}>{typeMeta?.primaryContentLabel || 'Description'}</label>
              <textarea id="story-draft-content" value={preview.content} rows={6}
                onChange={(e) => setPreview((p) => ({ ...p, content: e.target.value }))} className={fieldClass} />
            </div>
            <button type="button" onClick={save} disabled={saving || !preview.name.trim()} className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>
              {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {story ? `Save to ${story.name}` : `Save to ${library.label}`}
            </button>
          </div>
        )}
      </div>
    </Drawer>
  );
}

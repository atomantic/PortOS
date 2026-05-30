/**
 * Quick Idea (Catalog) — dashboard widget mirroring QuickBrainCapture, but
 * landing into the Creative Ingredients Catalog instead of the brain inbox.
 *
 * Fast path: the user already knows the type (character / place / object /
 * idea / scene / concept) and the primary text, so this widget skips the
 * scrap+extract LLM round-trip on /catalog/ingest. One click on a type chip,
 * one name, one textarea, one submit → POST /api/catalog/ingredients.
 *
 * Types, type-chip colors, and the per-type primary content key/label all
 * come from the shared registry (`client/src/lib/catalogTypes.js`).
 */

import { useState, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import toast from './ui/Toast';
import TagPicker from './TagPicker';
import { createCatalogIngredient } from '../services/apiCatalog';
import { CATALOG_TYPES, getCatalogType } from '../lib/catalogTypes';

const TYPES = CATALOG_TYPES;

// Per-tag length cap (mirrors BIBLE_LIMITS.TAG_MAX used by
// catalogIngredientCreateSchema) + tag-count cap (mirrors
// BIBLE_LIMITS.TAGS_PER_ENTRY_MAX). The server still re-validates + normalizes;
// these keep the fast-capture submit from 400-ing on an oversized tag.
const TAG_MAX_CHARS = 60;
const TAGS_MAX = 12;

export default function QuickIdeaCapture() {
  const [type, setType] = useState('idea');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const typeMeta = useMemo(() => getCatalogType(type) || TYPES[0], [type]);
  const contentKey = typeMeta.primaryContentKey || 'description';
  const contentLabel = typeMeta.primaryContentLabel || 'Description';

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || submittingRef.current) return;

    // Synchronous ref lock prevents duplicate requests from rapid clicks/Enter.
    submittingRef.current = true;
    setIsSubmitting(true);

    const payload = {};
    const trimmedContent = content.trim();
    if (trimmedContent) payload[contentKey] = trimmedContent;

    // silent: own error UI below — avoids double-toast through the request helper.
    const created = await createCatalogIngredient(
      { type, name: trimmedName, payload, tags },
      { silent: true },
    ).catch((err) => {
      toast.error(err?.message || 'Failed to capture');
      return null;
    });

    submittingRef.current = false;
    setIsSubmitting(false);

    if (!created?.id) return;

    // Optimistic clear so the user can keep capturing rapid-fire.
    setName('');
    setContent('');
    setTags([]);

    // Toast with an "Open" link to the freshly-created ingredient detail.
    toast.success(
      <span>
        Saved {typeMeta.label.toLowerCase()}.{' '}
        <Link to={`/catalog/${created.type}/${created.id}`} className="underline">Open</Link>
      </span>,
    );
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Quick Idea</h3>
        <Link to="/catalog" className="text-xs text-gray-500 hover:text-port-accent transition-colors">
          Catalog &rarr;
        </Link>
      </div>
      <form onSubmit={handleSubmit} className="space-y-2">
        {/* Type chip row — wraps on narrow widths so the widget stays usable on phones. */}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Ingredient type">
          {TYPES.map((t) => {
            const active = t.id === type;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setType(t.id)}
                className={`px-2 py-1 rounded-full text-xs border transition-colors ${
                  active ? t.badgeColor : 'border-port-border text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <label htmlFor="quick-idea-name" className="sr-only">Name</label>
        <input
          id="quick-idea-name"
          type="text"
          placeholder={`Name (e.g. ${typeMeta.label})`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
        />

        <label htmlFor="quick-idea-content" className="sr-only">{contentLabel}</label>
        <textarea
          id="quick-idea-content"
          placeholder={contentLabel}
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent resize-none"
        />

        <div className="flex gap-2 items-start">
          <div className="flex-1">
            <label htmlFor="quick-idea-tags" className="sr-only">Tags</label>
            <TagPicker
              id="quick-idea-tags"
              value={tags}
              onChange={setTags}
              placeholder="Tags…"
              maxTags={TAGS_MAX}
              maxTagChars={TAG_MAX_CHARS}
            />
          </div>
          <button
            type="submit"
            disabled={!name.trim() || isSubmitting}
            className="flex items-center gap-1 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
            aria-label="Save to catalog"
          >
            <Send size={14} />
          </button>
        </div>
      </form>
    </div>
  );
}

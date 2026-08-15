/**
 * MusicDesigner (#4305) — the Music studio's Generate tab, as a stepped
 * designer instead of a bare three-field form.
 *
 *   concept → description → lyrics (optional) → render
 *
 * The user starts from a short reference/vibe ("a cross between X and Y"), an
 * AI provider of their choosing expands it into a rich, genre-dense musical
 * description, they optionally generate lyrics from that description plus their
 * own extra guidance, and the existing `MusicGenPanel` renders the track. Every
 * step's output lands in an editable textarea — **the AI drafts, the human owns
 * the text** — and every step stays revisitable from the step bar.
 *
 * Two constraints shape this component:
 *
 * - **No cold-bootstrap LLM calls** (root CLAUDE.md). Both provider calls fire
 *   only from an explicit button press in the same interaction — nothing runs
 *   on mount, on blur, or ahead of the user.
 * - **Selection lives in the URL.** The active step is the `:id` slot of the
 *   existing `music/:tab/:id` route (`/music/generate/description`), so it is
 *   deep-linkable and reload-safe. Text state is in-memory for the tab's
 *   lifetime (drafts are out of scope); the provider/model/effort pin and the
 *   meta-prompt overrides persist to `settings.music.designer`.
 */

import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import {
  AudioLines, ChevronDown, ChevronUp, FileText, Lightbulb, Loader2, Mic2, Sparkles, Wand2,
} from 'lucide-react';
import MusicGenPanel from './MusicGenPanel';
import ProviderModelSelector from '../ProviderModelSelector';
import TabPills from '../ui/TabPills';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import useProviderModels from '../../hooks/useProviderModels';
import { describeMusic, generateLyrics, getSettings, updateSettings } from '../../services/api';

const STEPS = [
  { id: 'concept', label: 'Concept', icon: Lightbulb },
  { id: 'description', label: 'Description', icon: FileText },
  { id: 'lyrics', label: 'Lyrics', icon: Mic2 },
  { id: 'render', label: 'Render', icon: AudioLines },
];
const STEP_IDS = STEPS.map((s) => s.id);
const FIRST_STEP = STEP_IDS[0];

// Display-only mirrors of the shipped meta-prompts in
// `server/services/musicDesigner.js`. They are rendered as placeholder text so
// the user can see what they're overriding; the SERVER is the authority — an
// empty override field sends no `template` at all and the server falls back to
// its own constant, so drift here is cosmetic and can never change what runs.
const DESCRIBE_PLACEHOLDER = 'Describe the given musical reference and description in richer detail in English, focusing primarily on the sound, instruments, feel, and the overall atmosphere. Also briefly describe the composition, instrumentation, beats, lyrical or instrumental style (maybe it doesn\'t have lyrics), and aesthetic. Keep it concise and genre-focused rather than overly technical.';
const LYRICS_PLACEHOLDER = 'Write original song lyrics that fit the musical description below. Use the section syntax the audio engine expects: a bracketed section tag alone on its line ([verse], [chorus], [bridge], [outro]) with that section\'s lines beneath it. Match the mood, genre, energy, and vocal style implied by the description, and keep the phrasing singable. Keep the lyrics original (do not reproduce copyrighted lyrics verbatim).';

const FIELD_CLASS = 'w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const LABEL_CLASS = 'mb-1 block text-xs uppercase tracking-wider text-gray-500';
const PRIMARY_BTN = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-port-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-port-accent/80 disabled:opacity-50 min-h-[40px]';
const GHOST_BTN = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 py-2 text-sm text-gray-300 transition-colors hover:border-port-accent hover:text-white disabled:opacity-50 min-h-[40px]';

export default function MusicDesigner() {
  const navigate = useNavigate();
  const { id } = useParams();
  const mountedRef = useMounted();

  // Wizard text — lifted here so MusicGenPanel (which never writes back to
  // prompt/lyrics) can be re-hosted under step 4 unchanged, and so edits
  // survive step navigation.
  const [concept, setConcept] = useState('');
  const [conceptGuidance, setConceptGuidance] = useState('');
  const [description, setDescription] = useState('');
  const [lyricsGuidance, setLyricsGuidance] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [title, setTitle] = useState('');

  // Meta-prompt overrides. Blank = "use the shipped default" (resolved
  // server-side), which is exactly what "Reset to default" restores.
  const [describeTemplate, setDescribeTemplate] = useState('');
  const [lyricsTemplate, setLyricsTemplate] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [effort, setEffort] = useState('');
  const [describing, setDescribing] = useState(false);
  const [writing, setWriting] = useState(false);
  // Saved provider pin, parked until the provider list loads — the hook
  // auto-selects a default when its list arrives, so applying immediately would
  // race that load (same pattern as ChiptunePanel).
  const [savedPin, setSavedPin] = useState(null);
  const musicSettingsRef = useRef({});

  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading,
  } = useProviderModels({ silent: true, withEffort: true });

  // Load saved prefs once. Templates apply immediately; the provider pin waits
  // for the provider list.
  useEffect(() => {
    getSettings({ silent: true }).then((settings) => {
      if (!mountedRef.current) return;
      const music = settings?.music || {};
      musicSettingsRef.current = music;
      const saved = music.designer || {};
      if (saved.describeTemplate) setDescribeTemplate(saved.describeTemplate);
      if (saved.lyricsTemplate) setLyricsTemplate(saved.lyricsTemplate);
      if (saved.providerId) {
        setSavedPin({ providerId: saved.providerId, model: saved.model || '', effort: saved.effort || '' });
      } else if (saved.effort) {
        setEffort(saved.effort);
      }
    }).catch(() => {});
  }, []);

  // Apply the saved pin once providers are loaded. A stale saved provider id
  // degrades to the hook's own default selection; a stale saved MODEL is
  // skipped too — the select doesn't render unmatched values, so applying it
  // would send a model the provider no longer has while showing another.
  useEffect(() => {
    if (!savedPin || providersLoading || !providers.length) return;
    const provider = providers.find((p) => p.id === savedPin.providerId);
    if (provider) {
      setSelectedProviderId(savedPin.providerId);
      const models = (provider.models?.length ? provider.models : [provider.defaultModel])
        .map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
      if (savedPin.model && models.includes(savedPin.model)) setSelectedModel(savedPin.model);
      if (savedPin.effort) setEffort(savedPin.effort);
    }
    setSavedPin(null); // apply once
  }, [savedPin, providersLoading, providers, setSelectedProviderId, setSelectedModel]);

  const persistDesignerPrefs = (patch) => {
    const music = musicSettingsRef.current;
    const next = { ...music, designer: { ...(music.designer || {}), ...patch } };
    musicSettingsRef.current = next;
    updateSettings({ music: next }, { silent: true }).catch(() => {});
  };

  const goTo = (stepId) => navigate(`/music/generate/${stepId}`);

  const runDescribe = async ({ advance }) => {
    if (!concept.trim()) { toast.error('Describe the vibe (or name a reference) first'); return; }
    setDescribing(true);
    const res = await describeMusic({
      concept: concept.trim(),
      guidance: conceptGuidance.trim() || undefined,
      template: describeTemplate.trim() || undefined,
      providerId: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not describe the music'); return null; });
    if (!mountedRef.current) return;
    setDescribing(false);
    if (!res?.description) return;
    setDescription(res.description);
    persistDesignerPrefs({ providerId: selectedProviderId || '', model: selectedModel || '', effort: effort || '' });
    if (advance) goTo('description');
  };

  const runLyrics = async () => {
    if (!description.trim()) { toast.error('Write the musical description first'); return; }
    setWriting(true);
    const res = await generateLyrics({
      description: description.trim(),
      guidance: lyricsGuidance.trim() || undefined,
      template: lyricsTemplate.trim() || undefined,
      providerId: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not write the lyrics'); return null; });
    if (!mountedRef.current) return;
    setWriting(false);
    if (!res?.lyrics) return;
    setLyrics(res.lyrics);
    persistDesignerPrefs({ providerId: selectedProviderId || '', model: selectedModel || '', effort: effort || '' });
  };

  const busy = describing || writing;

  const providerPicker = (
    <ProviderModelSelector
      providers={providers}
      selectedProviderId={selectedProviderId}
      selectedModel={selectedModel}
      availableModels={availableModels}
      onProviderChange={(pid) => { setSelectedProviderId(pid); setEffort(''); }}
      onModelChange={setSelectedModel}
      effort={effort}
      onEffortChange={setEffort}
      disabled={busy || providersLoading}
      layout="stacked"
    />
  );

  // Unknown step → the first step, rather than an empty shell (mirrors the tab
  // fallback in pages/Music.jsx). Declared after the hooks so the hook order is
  // stable across the redirect render.
  const step = id || FIRST_STEP;
  if (!STEP_IDS.includes(step)) return <Navigate to={`/music/generate/${FIRST_STEP}`} replace />;

  return (
    <section className="max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Design a tune</h2>
        <p className="text-sm text-gray-400">
          Start from a reference or a vibe. AI drafts the musical description and the lyrics — you edit both before anything is rendered.
        </p>
      </div>

      <TabPills
        tabs={STEPS}
        activeTab={step}
        onChange={goTo}
        mobileDropdown
        mobileSelectId="music-designer-step"
        ariaLabel="Music designer steps"
      />

      {step === 'concept' && (
        <div className="space-y-4">
          <label htmlFor="music-designer-concept" className="block">
            <span className={LABEL_CLASS}>What do you want to hear?</span>
            <textarea
              id="music-designer-concept"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
              rows={3}
              maxLength={8000}
              placeholder="A cross between a rain-soaked downtempo instrumental and a late-night synth ballad…"
              className={FIELD_CLASS}
            />
          </label>

          <label htmlFor="music-designer-concept-guidance" className="block">
            <span className={LABEL_CLASS}>Extra guidance (optional)</span>
            <input
              id="music-designer-concept-guidance"
              value={conceptGuidance}
              onChange={(event) => setConceptGuidance(event.target.value)}
              maxLength={4000}
              placeholder="Keep it under 100 BPM, no vocals in the intro…"
              className={FIELD_CLASS}
            />
          </label>

          <div className="rounded border border-port-border bg-port-bg/60 p-3">
            <span className={LABEL_CLASS}>AI provider</span>
            {providerPicker}
          </div>

          <div className="rounded border border-port-border bg-port-bg/60">
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-gray-300 hover:text-white min-h-[40px]"
            >
              <span>Advanced — meta-prompts</span>
              {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {advancedOpen && (
              <div className="space-y-3 border-t border-port-border p-3">
                <p className="text-xs text-gray-500">
                  Leave a field blank to use the shipped instruction shown in it.
                </p>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="music-designer-describe-template" className={LABEL_CLASS}>Description instruction</label>
                    <button
                      type="button"
                      onClick={() => { setDescribeTemplate(''); persistDesignerPrefs({ describeTemplate: '' }); }}
                      disabled={!describeTemplate}
                      className="text-xs text-port-accent hover:underline disabled:opacity-40 min-h-[32px]"
                    >
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id="music-designer-describe-template"
                    value={describeTemplate}
                    onChange={(event) => setDescribeTemplate(event.target.value)}
                    onBlur={() => persistDesignerPrefs({ describeTemplate: describeTemplate.trim() })}
                    rows={4}
                    maxLength={8000}
                    placeholder={DESCRIBE_PLACEHOLDER}
                    className={FIELD_CLASS}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="music-designer-lyrics-template" className={LABEL_CLASS}>Lyrics instruction</label>
                    <button
                      type="button"
                      onClick={() => { setLyricsTemplate(''); persistDesignerPrefs({ lyricsTemplate: '' }); }}
                      disabled={!lyricsTemplate}
                      className="text-xs text-port-accent hover:underline disabled:opacity-40 min-h-[32px]"
                    >
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id="music-designer-lyrics-template"
                    value={lyricsTemplate}
                    onChange={(event) => setLyricsTemplate(event.target.value)}
                    onBlur={() => persistDesignerPrefs({ lyricsTemplate: lyricsTemplate.trim() })}
                    rows={4}
                    maxLength={8000}
                    placeholder={LYRICS_PLACEHOLDER}
                    className={FIELD_CLASS}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => runDescribe({ advance: true })}
              disabled={busy || !concept.trim()}
              className={PRIMARY_BTN}
            >
              {describing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              <span>{describing ? 'Describing…' : 'Describe it'}</span>
            </button>
            {description.trim() && (
              <button type="button" onClick={() => goTo('description')} disabled={busy} className={GHOST_BTN}>
                Keep my description
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'description' && (
        <div className="space-y-4">
          <label htmlFor="music-designer-description" className="block">
            <span className={LABEL_CLASS}>Music description</span>
            <textarea
              id="music-designer-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={8}
              maxLength={8000}
              placeholder="Warm instrumental soul, relaxed pocket, Rhodes piano, 92 BPM…"
              className={FIELD_CLASS}
            />
          </label>
          <p className="text-xs text-gray-500">This is what conditions the render — edit it freely.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => runDescribe({ advance: false })}
              disabled={busy || !concept.trim()}
              className={GHOST_BTN}
            >
              {describing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              <span>{describing ? 'Regenerating…' : 'Regenerate'}</span>
            </button>
            <button
              type="button"
              onClick={() => goTo('lyrics')}
              disabled={busy || !description.trim()}
              className={PRIMARY_BTN}
            >
              Next: lyrics
            </button>
          </div>
        </div>
      )}

      {step === 'lyrics' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Lyrics are optional — leave them blank for an instrumental.
          </p>
          <label htmlFor="music-designer-lyrics-guidance" className="block">
            <span className={LABEL_CLASS}>Lyric guidance (optional)</span>
            <input
              id="music-designer-lyrics-guidance"
              value={lyricsGuidance}
              onChange={(event) => setLyricsGuidance(event.target.value)}
              maxLength={4000}
              placeholder="Make the chorus about leaving a city at dawn…"
              className={FIELD_CLASS}
            />
          </label>
          <div className="rounded border border-port-border bg-port-bg/60 p-3">
            <span className={LABEL_CLASS}>AI provider</span>
            {providerPicker}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runLyrics}
              disabled={busy || !description.trim()}
              className={PRIMARY_BTN}
            >
              {writing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              <span>{writing ? 'Writing lyrics…' : (lyrics.trim() ? 'Rewrite lyrics' : 'Generate lyrics')}</span>
            </button>
            {lyrics.trim() && (
              <button type="button" onClick={() => setLyrics('')} disabled={busy} className={GHOST_BTN}>
                Clear lyrics
              </button>
            )}
          </div>
          <label htmlFor="music-designer-lyrics" className="block">
            <span className={LABEL_CLASS}>Lyrics</span>
            <textarea
              id="music-designer-lyrics"
              value={lyrics}
              onChange={(event) => setLyrics(event.target.value)}
              rows={10}
              maxLength={20000}
              placeholder={'[verse]\n…\n[chorus]\n…'}
              className={`${FIELD_CLASS} font-mono`}
            />
          </label>
          <button type="button" onClick={() => goTo('render')} disabled={busy} className={PRIMARY_BTN}>
            {lyrics.trim() ? 'Next: render' : 'Skip — make it instrumental'}
          </button>
        </div>
      )}

      {step === 'render' && (
        <div className="space-y-4">
          <label htmlFor="music-designer-title" className="block">
            <span className={LABEL_CLASS}>Title (optional)</span>
            <input
              id="music-designer-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="Derived from the prompt if left blank"
              className={FIELD_CLASS}
            />
          </label>
          <MusicGenPanel
            title={title}
            prompt={description}
            lyrics={lyrics}
            onGenerated={(track) => navigate(`/music/tracks/${encodeURIComponent(track.id)}`)}
          />
        </div>
      )}
    </section>
  );
}

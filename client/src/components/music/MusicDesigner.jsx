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
 * - **No cold-bootstrap LLM calls** (root AGENTS.md). Both provider calls fire
 *   only from an explicit button press in the same interaction — nothing runs
 *   on mount, on blur, or ahead of the user.
 * - **Selection lives in the URL.** The active step is the `:id` slot of the
 *   existing `music/:tab/:id` route (`/music/generate/description`), while the
 *   persisted draft track rides in `?trackId=…`, so the wizard is deep-linkable
 *   and reload-safe. Provider/model/effort pins and meta-prompt overrides
 *   persist to `settings.music.designer` too.
 */

import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  AudioLines, ChevronDown, ChevronUp, FileText, Lightbulb, Loader2, Mic2, Sparkles, Wand2,
} from 'lucide-react';
import MusicGenPanel from './MusicGenPanel';
import ProviderModelSelector from '../ProviderModelSelector';
import TabPills from '../ui/TabPills';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import useProviderModels from '../../hooks/useProviderModels';
import { safeReadStorage, safeRemoveStorage, safeWriteStorage } from '../../lib/safeStorage.js';
import {
  createTrack, describeMusic, generateLyrics, getSettings, getTrack, updateSettings, updateTrack,
} from '../../services/api';

const STEPS = [
  { id: 'concept', label: 'Concept', icon: Lightbulb },
  { id: 'description', label: 'Description', icon: FileText },
  { id: 'lyrics', label: 'Lyrics', icon: Mic2 },
  { id: 'render', label: 'Render', icon: AudioLines },
];
const STEP_IDS = STEPS.map((s) => s.id);
const FIRST_STEP = STEP_IDS[0];
const DRAFT_TITLE = 'Untitled music draft';
const ACTIVE_DRAFT_KEY = 'portos.musicDesigner.activeDraft';

// Display-only summaries of the shipped meta-prompts in
// `server/services/musicDesigner.js`. The SERVER is the authority — an empty
// override sends no `template` and uses the complete shipped instruction.
const DESCRIBE_PLACEHOLDER = 'Rewrite the musical reference into a detailed, generation-oriented structured caption in English. Preserve explicit requirements and exclusions while developing genre and subgenres, emotional arc, imagery, sonics, production character, core instruments, and spatial feel. Describe approximate tempo, meter or time signature, rhythmic subdivision, and groove when they matter. Use exact BPM, key, scale, or time signature only when deliberately requested. State the vocal plan explicitly; for instrumental music, rule out vocals and name the lead melodic instrument. Treat the arrangement as a continuous section-by-section timeline with plausible entrances, exits, changes, and transitions. Keep lyric words out of the caption.';
const LYRICS_PLACEHOLDER = 'Write original, singable song lyrics that fit the musical description. Put every bracketed section tag alone on its own line, using useful tags such as [intro], [verse], [pre-chorus], [chorus], [post-chorus], [bridge], [instrumental], [solo], and [outro], with words beginning on the following line. Build enough sections for the intended song length. Keep tempo, meter, key, arrangement, and production instructions in the separate musical description.';

const FIELD_CLASS = 'w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const LABEL_CLASS = 'mb-1 block text-xs uppercase tracking-wider text-gray-500';
const PRIMARY_BTN = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-port-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-port-accent/80 disabled:opacity-50 min-h-[40px]';
const GHOST_BTN = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 py-2 text-sm text-gray-300 transition-colors hover:border-port-accent hover:text-white disabled:opacity-50 min-h-[40px]';

export default function MusicDesigner() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const mountedRef = useMounted();
  const requestedTrackId = searchParams.get('trackId') || '';
  const storedDraftId = requestedTrackId || safeReadStorage(ACTIVE_DRAFT_KEY) || '';

  // Wizard text — lifted here so MusicGenPanel (which never writes back to
  // prompt/lyrics) can be re-hosted under step 4 unchanged, and so edits
  // survive step navigation.
  const [concept, setConcept] = useState('');
  const [conceptGuidance, setConceptGuidance] = useState('');
  const [description, setDescription] = useState('');
  const [lyricsGuidance, setLyricsGuidance] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [title, setTitle] = useState('');
  const [trackId, setTrackId] = useState('');
  const [draftLoading, setDraftLoading] = useState(true);
  const draftSaveTailRef = useRef(Promise.resolve());

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

  const stepFromUrl = STEP_IDS.includes(id) ? id : FIRST_STEP;

  const hydrateDraft = (track) => {
    setTrackId(track.id);
    if (track.title === DRAFT_TITLE) safeWriteStorage(ACTIVE_DRAFT_KEY, track.id);
    else if (safeReadStorage(ACTIVE_DRAFT_KEY) === track.id) safeRemoveStorage(ACTIVE_DRAFT_KEY);
    setConcept(track.concept || '');
    setDescription(track.prompt || '');
    setLyrics(track.lyrics || '');
    setTitle(track.title === DRAFT_TITLE ? '' : (track.title || ''));
  };

  // Create the persisted record before the first designer action. Its id is
  // carried in the URL so step navigation and browser-history returns resolve
  // the same draft instead of starting a second in-memory wizard.
  useEffect(() => {
    let cancelled = false;
    const createDraft = async () => {
      const created = await createTrack({ title: DRAFT_TITLE }, { silent: true }).catch((err) => {
        if (mountedRef.current) toast.error(err?.message || 'Could not create a music draft');
        return null;
      });
      if (cancelled || !mountedRef.current) return;
      if (created) {
        hydrateDraft(created);
        navigate(`/music/generate/${stepFromUrl}?trackId=${encodeURIComponent(created.id)}`, { replace: true });
      }
      setDraftLoading(false);
    };

    if (storedDraftId) {
      getTrack(storedDraftId, { silent: true }).then((track) => {
        if (cancelled || !mountedRef.current) return;
        if (track) {
          hydrateDraft(track);
          if (!requestedTrackId) {
            navigate(`/music/generate/${stepFromUrl}?trackId=${encodeURIComponent(track.id)}`, { replace: true });
          }
          setDraftLoading(false);
        } else {
          createDraft();
        }
      }).catch(() => createDraft());
    } else {
      createDraft();
    }
    return () => { cancelled = true; };
  }, []);

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

  const saveDraft = (patch) => {
    if (!trackId || !patch || Object.keys(patch).length === 0) return Promise.resolve(null);
    draftSaveTailRef.current = draftSaveTailRef.current
      .catch(() => null)
      .then(() => updateTrack(trackId, patch, { silent: true }))
      .catch((err) => {
        if (mountedRef.current) toast.error(err?.message || 'Could not save the music draft');
        return null;
      });
    return draftSaveTailRef.current;
  };

  const goTo = (stepId) => {
    const suffix = trackId ? `?trackId=${encodeURIComponent(trackId)}` : '';
    navigate(`/music/generate/${stepId}${suffix}`);
  };

  const runDescribe = async ({ advance }) => {
    if (!concept.trim()) { toast.error('Describe the vibe (or name a reference) first'); return; }
    saveDraft({ concept: concept.trim() });
    setDescribing(true);
    const res = await describeMusic({
      concept: concept.trim(),
      guidance: conceptGuidance.trim() || undefined,
      template: describeTemplate.trim() || undefined,
      providerId: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not describe the music'); return null; });
    if (mountedRef.current) setDescribing(false);
    if (!res?.description) return;
    saveDraft({ concept: concept.trim(), prompt: res.description });
    if (!mountedRef.current) return;
    setDescription(res.description);
    persistDesignerPrefs({ providerId: selectedProviderId || '', model: selectedModel || '', effort: effort || '' });
    if (advance) goTo('description');
  };

  const runLyrics = async () => {
    if (!description.trim()) { toast.error('Write the musical description first'); return; }
    saveDraft({ prompt: description.trim() });
    setWriting(true);
    const res = await generateLyrics({
      description: description.trim(),
      guidance: lyricsGuidance.trim() || undefined,
      template: lyricsTemplate.trim() || undefined,
      providerId: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not write the lyrics'); return null; });
    if (mountedRef.current) setWriting(false);
    if (!res?.lyrics) return;
    saveDraft({ lyrics: res.lyrics });
    if (!mountedRef.current) return;
    setLyrics(res.lyrics);
    persistDesignerPrefs({ providerId: selectedProviderId || '', model: selectedModel || '', effort: effort || '' });
  };

  const busy = describing || writing;
  const draftReady = !!trackId && !draftLoading;

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
      disabled={busy || providersLoading || !draftReady}
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
          Start from a reference or a vibe. AI drafts a structured musical caption and optional lyrics — you edit both before anything is rendered.
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
              onBlur={() => saveDraft({ concept: concept.trim() })}
              disabled={draftLoading}
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
              disabled={draftLoading}
              maxLength={4000}
              placeholder="90–96 BPM, 6/8 meter, D minor, instrumental only with a cello lead…"
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
                  Leave a field blank to use the complete shipped instruction summarized by its placeholder.
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
              disabled={busy || !draftReady || !concept.trim()}
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
              onBlur={() => saveDraft({ prompt: description.trim() })}
              disabled={draftLoading}
              rows={8}
              maxLength={8000}
              placeholder={'Global Metadata\nBasic Attributes: 92 BPM, 6/8 meter, warm instrumental soul…\n\nVocal Details\nInstrumental only; the Rhodes carries the lead melody…\n\nArrangement\nIntro: sparse keys enter first…'}
              className={FIELD_CLASS}
            />
          </label>
          <div className="rounded border border-port-border bg-port-bg/60 p-3 text-xs text-gray-400">
            <p className="mb-2 font-medium text-gray-300">MiniMax structured caption</p>
            <ul className="list-disc space-y-1 pl-4">
              <li><span className="text-gray-300">Global Metadata</span> — genre, tempo/BPM, meter or time signature, groove, emotional arc, imagery, and mix profile.</li>
              <li><span className="text-gray-300">Vocal Details</span> — explicit vocal performance, or “instrumental” plus the lead melodic instrument or texture.</li>
              <li><span className="text-gray-300">Arrangement</span> — a section-by-section timeline of entrances, exits, transitions, texture, and energy.</li>
            </ul>
            <p className="mt-2 text-gray-500">Use exact BPM, key, scale, or meter only when you mean it. This entire caption conditions the render.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => runDescribe({ advance: false })}
              disabled={busy || !draftReady || !concept.trim()}
              className={GHOST_BTN}
            >
              {describing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              <span>{describing ? 'Regenerating…' : 'Regenerate'}</span>
            </button>
            <button
              type="button"
              onClick={() => goTo('lyrics')}
              disabled={busy || !draftReady || !description.trim()}
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
              disabled={draftLoading}
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
              disabled={busy || !draftReady || !description.trim()}
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
              onBlur={() => saveDraft({ lyrics: lyrics.trim() })}
              disabled={draftLoading}
              rows={10}
              maxLength={20000}
              placeholder={'[verse]\n…\n[chorus]\n…'}
              className={`${FIELD_CLASS} font-mono`}
            />
          </label>
          <button type="button" onClick={() => { saveDraft({ prompt: description.trim(), lyrics: lyrics.trim() }); goTo('render'); }} disabled={busy || !draftReady} className={PRIMARY_BTN}>
            {lyrics.trim() ? 'Next: render' : 'Continue without lyrics'}
          </button>
          {!lyrics.trim() && (
            <p className="text-xs text-gray-500">
              On the render step, enable Instrumental only to prohibit wordless or background vocals too.
            </p>
          )}
          <details className="rounded border border-port-border bg-port-bg/60 p-3 text-xs text-gray-400">
            <summary className="cursor-pointer font-medium text-gray-300">Manual composition structure</summary>
            <div className="pt-2">
              <p className="mb-2">Put one section tag on its own line, then begin its singable words on the next line. A useful arc is: intro → verse → pre-chorus → chorus → verse 2 → chorus → bridge → final chorus → outro.</p>
              <ul className="mb-3 list-disc space-y-1 pl-4">
                <li>Use 4–8 short lines for a verse and 2–4 lines for a pre-chorus or bridge.</li>
                <li>Give the chorus a repeated hook; repeat the tag when the chorus returns.</li>
                <li>Use tags such as <code className="text-gray-300">[instrumental]</code> and <code className="text-gray-300">[solo]</code> for wordless sections; keep tempo, meter, and production direction in the description.</li>
                <li>Include enough sections for the intended duration—MiniMax can end early when the lyric structure runs out.</li>
              </ul>
              <pre className="overflow-x-auto rounded bg-port-bg p-2 font-mono text-[11px] text-gray-300">{`[verse]\nShort image, short line\nA second line to sing\n\n[pre-chorus]\nBuild the thought\nTurn toward the hook\n\n[chorus]\nA repeatable hook\nA repeatable hook`}</pre>
            </div>
          </details>
        </div>
      )}

      {step === 'render' && (
        <div className="space-y-4">
          <label htmlFor="music-designer-render-prompt" className="block">
            <span className={LABEL_CLASS}>Prompt for this render</span>
            <textarea
              id="music-designer-render-prompt"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => saveDraft({ prompt: description.trim() })}
              disabled={draftLoading}
              rows={6}
              maxLength={8000}
              placeholder={'Describe the sound, arrangement, vocals, instruments, mood, and production direction…'}
              aria-describedby="music-designer-render-prompt-hint"
              className={FIELD_CLASS}
            />
            <span id="music-designer-render-prompt-hint" className="mt-1 block text-xs text-gray-500">
              Required. This editable description is the prompt sent to the selected audio engine.
            </span>
          </label>
          <label htmlFor="music-designer-title" className="block">
            <span className={LABEL_CLASS}>Title (optional)</span>
            <input
              id="music-designer-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                const nextTitle = title.trim() || DRAFT_TITLE;
                if (title.trim()) safeRemoveStorage(ACTIVE_DRAFT_KEY);
                else safeWriteStorage(ACTIVE_DRAFT_KEY, trackId);
                saveDraft({ title: nextTitle });
              }}
              disabled={!draftReady}
              maxLength={200}
              placeholder="Derived from the prompt if left blank"
              className={FIELD_CLASS}
            />
          </label>
          <MusicGenPanel
            track={trackId ? { id: trackId } : undefined}
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

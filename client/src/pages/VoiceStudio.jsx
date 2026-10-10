import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AudioLines, Plus, Loader2, ArrowLeft, Check } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { usePagedCollection } from '../hooks/usePagedCollection';
import InfiniteScrollFooter from '../components/ui/InfiniteScrollFooter';
import { useSocketResource } from '../hooks/useSocketResource';
import useAsyncAction from '../hooks/useAsyncAction';
import useMounted from '../hooks/useMounted';
import { listUniverseNames, getUniverse } from '../services/apiUniverseBuilder';
import { listStudioVoices, getStudioVoice, getVoiceStudioStatus, setupVoiceStudio, unloadVoiceStudio,
  designStudioVoice, assignStudioVoice } from '../services/apiVoice';
import { formatCount } from '../utils/formatters';

const EVENTS = ['voice-studio:changed'];
const NO_EVENTS = [];
const fieldClass = 'w-full min-w-0 rounded border border-port-border bg-port-bg p-2 text-sm';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-40';
const audioUrl = filename => `/data/${filename.split('/').map(encodeURIComponent).join('/')}`;

function VoiceDesignForm({ character, source, ready, onCreated }) {
  const mounted = useMounted();
  const [label, setLabel] = useState(source?.label ? `${source.label} variation` : character?.name ? `${character.name} voice` : '');
  const [instructions, setInstructions] = useState(source?.inference?.instructions || [character?.speechAccent, character?.speechPattern].filter(Boolean).join('. '));
  const [text, setText] = useState(source?.sourceAssets?.[0]?.transcript || 'There is more to this story than we first imagined.');
  const [seed, setSeed] = useState(source?.inference?.seed ?? 42);
  const [rate, setRate] = useState(source?.inference?.rate || 1);
  const [pitch, setPitch] = useState(source?.inference?.pitchSemitones || 0);
  const [duration, setDuration] = useState(source?.inference?.genSeconds || 4);
  const [generate, generating] = useAsyncAction(async () => {
    const result = await designStudioVoice({ label, instructions, text, seed, rate,
      pitchSemitones: pitch, genSeconds: duration }, { silent: true });
    if (mounted.current) onCreated(result.profile);
  });
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!generating) generate(); }}>
    <h2 className="text-lg font-semibold">Design a character voice</h2>
    <p className="text-sm text-gray-400">AuK-Flash · local Apple Silicon. Describe timbre, accent, age, and delivery, then audition a short line. Each generation saves a new candidate in your library.</p>
    <fieldset disabled={generating} className="min-w-0 space-y-3">
      <div><label htmlFor="voice-label" className="block text-sm mb-1">Voice name</label>
        <input id="voice-label" required maxLength={160} value={label} onChange={event => setLabel(event.target.value)} className={fieldClass} /></div>
      <div><label htmlFor="voice-description" className="block text-sm mb-1">Timbre & character direction</label>
        <textarea id="voice-description" required maxLength={2000} rows={3} value={instructions} onChange={event => setInstructions(event.target.value)}
          placeholder="Warm low alto, slightly raspy texture, rounded vowels, measured delivery…" className={fieldClass} /></div>
      <div><label htmlFor="voice-preview-text" className="block text-sm mb-1">Preview dialogue</label>
        <textarea id="voice-preview-text" required maxLength={400} rows={2} value={text} onChange={event => setText(event.target.value)} className={fieldClass} /></div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
        <div><label htmlFor="voice-pitch" className="block text-sm">Pitch edit: {pitch} semitones</label>
          <input id="voice-pitch" type="range" min={-12} max={12} step={1} value={pitch} onChange={event => setPitch(Number(event.target.value))} className="w-full" /></div>
        <div><label htmlFor="voice-rate" className="block text-sm">Pace: {rate}×</label>
          <input id="voice-rate" type="range" min={0.5} max={2} step={0.1} value={rate} onChange={event => setRate(Number(event.target.value))} className="w-full" /></div>
        <div><label htmlFor="voice-seed" className="block text-sm mb-1">Variation seed</label>
          <input id="voice-seed" type="number" required min={0} max={2147483647} value={seed} onChange={event => setSeed(Number(event.target.value))} className={fieldClass} /></div>
        <div><label htmlFor="voice-duration" className="block text-sm mb-1">Base duration (seconds)</label>
          <input id="voice-duration" type="number" required min={2} max={6} step={0.5} value={duration} onChange={event => setDuration(Number(event.target.value))} className={fieldClass} /></div>
      </div>
      <p className="text-xs text-gray-500">Controls apply when you generate. Pace adjusts the target duration; pitch uses a second model edit. Keep the line short enough to fit. First generation also loads the model.</p>
    </fieldset>
    <button type="submit" disabled={!ready || generating || !label.trim() || !instructions.trim() || !text.trim()} className={buttonClass}>
      {generating ? <Loader2 size={16} className="animate-spin" /> : <AudioLines size={16} />}
      {generating ? 'Generating voice preview…' : 'Generate & save preview'}
    </button>
    <p className="text-xs text-gray-500">Characters keep their current voice until you explicitly assign a candidate.</p>
  </form>;
}

function VoiceAssignment({ profile, universeId, character, onAssigned }) {
  const [assigned, setAssigned] = useState(false);
  const [enableInteractive, setEnableInteractive] = useState(false);
  const [assign, assigning] = useAsyncAction(async () => {
    const result = await assignStudioVoice(profile.id, { universeId, characterId: character.id, enableInteractive }, { silent: true });
    setAssigned(true);
    onAssigned(result.profile);
  });
  const available = profile.approval.status === 'approved' && ['auk', 'piper'].includes(profile.engine);
  return <div className="space-y-2 border-t border-port-border pt-4">
    {profile.engine === 'auk' && <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={enableInteractive} disabled={assigning || assigned} onChange={event => setEnableInteractive(event.target.checked)} />
      <span>Use this voice in FableLoom live conversations too. Replies wait for the complete audio; a cold model can take about a minute. This is buffered playback, not streaming.</span>
    </label>}
    <button type="button" disabled={!character || !available || assigning || assigned} onClick={assign} className={buttonClass}>
      {assigning ? <Loader2 size={16} className="animate-spin" /> : assigned ? <Check size={16} /> : null}
      {assigned ? `Assigned to ${character.name}` : character ? `Use for ${character.name}` : 'Choose a character to assign'}
    </button>
    <p className="text-xs text-gray-400">Assignment saves a local snapshot for this universe character. Series dialogue uses this character’s approved studio voice. FableLoom live conversations use it when you enable buffered playback above; otherwise the existing live voice fallback remains.</p>
    {!available && <p className="text-sm text-port-warning">This legacy voice is not available for assignment here. Create an AuK voice or use a Piper preset.</p>}
  </div>;
}

export default function VoiceStudio() {
  const { profileId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const universeId = params.get('universeId') || '';
  const characterId = params.get('characterId') || '';
  const context = params.toString() ? `?${params}` : '';
  const newVoiceParams = new URLSearchParams(params);
  newVoiceParams.delete('from');
  const fetchPage = useCallback(({ cursor, signal }) => listStudioVoices({ cursor, limit: 30 }, { signal, silent: true }), []);
  const library = usePagedCollection(fetchPage);
  const engine = useSocketResource(async ({ reconcile, events }) => {
    if (events.length || (reconcile && library.loaded)) await library.reload();
    return getVoiceStudioStatus({ silent: true });
  }, { events: EVENTS });
  const detailId = profileId === 'new' ? params.get('from') : profileId;
  const detail = useSocketResource(async ({ signal }) => (await getStudioVoice(detailId, { signal, silent: true })).profile,
    { events: EVENTS, resourceKey: detailId, enabled: Boolean(detailId) });
  const universes = useSocketResource(() => listUniverseNames({ silent: true }), { events: NO_EVENTS });
  const universe = useSocketResource(() => getUniverse(universeId, { silent: true }),
    { events: NO_EVENTS, resourceKey: universeId, enabled: Boolean(universeId) });
  const character = universe.data?.characters?.find(item => item.id === characterId);
  const profiles = library.items;
  const variation = profileId === 'new' ? detail.data : null;
  const selected = profileId !== 'new' ? detail.data : null;
  const status = engine.data;
  const putProfile = () => library.reload();
  const [setup, settingUp] = useAsyncAction(async () => {
    const result = await setupVoiceStudio({ silent: true });
    engine.updateData(current => ({ ...current, ...result }));
  });
  const [unload, unloading] = useAsyncAction(async () => {
    await unloadVoiceStudio({ silent: true });
    engine.updateData(current => ({ ...current, loaded: false }));
  });
  const changeTarget = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key === 'universeId') next.delete('characterId');
    setParams(next);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon={AudioLines}
        title="Voice Studio"
        subtitle="Create voices once, audition them, and cast characters across your universes and stories."
        actions={<Link to={`/voices/new?${newVoiceParams}`} className={buttonClass}><Plus size={16} /> Create voice</Link>}
      />
      <div className="@container min-w-0 flex-1 min-h-0 overflow-auto p-4">
      <div className="space-y-4">
    {engine.error && <p role="alert" className="text-port-error">{engine.error.message} <button onClick={engine.refetch} className="underline">Retry</button></p>}
    {library.loading && <p role="status">Loading voice library…</p>}
    {status && <section aria-label="Voice engine" className="rounded border border-port-border p-3 flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-0 text-sm">
        <strong>AuK-Flash</strong> · {status.state === 'running' ? status.stage : status.busy ? 'Rendering voice…' : status.ready ? 'Ready on this Mac' : 'Setup required'}
        {!status.supported && <p className="text-gray-400">Generation requires an Apple Silicon Mac. Saved voices remain browsable.</p>}
        {status.error && <p role="alert" className="text-port-error">{status.error}</p>}
        {!status.ready && status.supported && <p className="text-xs text-gray-400">Setup installs an isolated runtime and downloads/converts several GB of model weights. Allow at least 40 GB of free disk space. No speech is generated during setup.</p>}
      </div>
      {status.supported && <button className={buttonClass} onClick={setup} disabled={settingUp || status.busy || status.state === 'running'}>{status.ready ? 'Repair setup' : 'Set up AuK locally'}</button>}
      {status.loaded && <button className="text-sm text-port-accent" onClick={unload} disabled={unloading || status.busy}>Unload model</button>}
    </section>}
    <section aria-label="Character assignment target" className="rounded border border-port-border p-3 space-y-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),24rem))] gap-3">
        <div><label htmlFor="voice-universe" className="block text-sm mb-1">Universe</label>
          <select id="voice-universe" value={universeId} onChange={event => changeTarget('universeId', event.target.value)} className={fieldClass}>
            <option value="">Choose a universe</option>{(universes.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>
        <div><label htmlFor="voice-character" className="block text-sm mb-1">Character</label>
          <select id="voice-character" value={characterId} disabled={!universe.data} onChange={event => changeTarget('characterId', event.target.value)} className={fieldClass}>
            <option value="">Choose a character</option>{(universe.data?.characters || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>
      </div>
      {(universes.error || universe.error) && <p role="alert" className="text-port-error">Unable to load character choices. Reload this page to retry.</p>}
      {universeId && !universe.loading && characterId && !character && <p role="alert">This character is no longer available. Choose another character.</p>}
      {universeId && <Link className="inline-flex items-center gap-1 text-sm text-port-accent" to={`/universes/${encodeURIComponent(universeId)}?tab=cast`}><ArrowLeft size={14} /> Back to universe cast</Link>}
    </section>
    <div className="grid grid-cols-1 @[760px]:grid-cols-[minmax(15rem,1fr)_minmax(0,2fr)] gap-4">
      <section aria-label="Voice library" className="min-w-0 rounded border border-port-border p-3 space-y-2">
        <h2 className="font-semibold">Library <span className="text-gray-500">({formatCount(library.total ?? profiles.length)})</span></h2>
        {!library.loading && !library.error && !profiles.length && <p className="text-sm text-gray-400">No voices yet. Create a voice, listen to the preview, then assign it to a character.</p>}
        {profiles.map(profile => <Link key={profile.id} to={`/voices/${encodeURIComponent(profile.id)}${context}`}
          aria-current={profile.id === profileId ? 'page' : undefined}
          className={`block rounded border p-3 break-words ${profile.id === profileId ? 'border-port-accent bg-port-accent/10' : 'border-port-border hover:border-port-accent/50'}`}>
          <span className="block text-sm font-medium">{profile.label || profile.voiceId}</span>
          <span className="text-xs text-gray-500">{profile.engine} · {profile.library ? 'Library voice' : 'Character snapshot'}</span>
        </Link>)}
        <InfiniteScrollFooter hasMore={library.hasMore} loading={library.loading} error={library.error} onLoadMore={library.loadMore} autoLoad={false} label="Load more voices" />
      </section>
      <section className="min-w-0 rounded border border-port-border p-4">
        {detailId && detail.error ? <p role="alert">Voice not found or unavailable. Select another voice from the library.</p> : detailId && detail.loading ? <p>Loading voice…</p> : profileId === 'new' ? ((universeId && universe.loading) || (detailId && detail.loading) ? <p>Loading voice direction…</p> :
          <VoiceDesignForm key={`${universeId}:${characterId}:${variation?.id || ""}`} character={character} source={variation} ready={status?.ready && !status.busy && status.state !== 'running'} onCreated={profile => {
            putProfile(profile); navigate(`/voices/${profile.id}${context}`);
          }} />) : selected ? <div className="space-y-4">
            <h2 className="text-lg font-semibold break-words">{selected.label || selected.voiceId}</h2>
            <p className="text-sm text-gray-400 whitespace-pre-wrap break-words">{selected.inference?.instructions || 'Preset voice'}</p>
            {selected.sourceAssets?.[0] && <div className="space-y-2">
              <p className="text-sm">{selected.sourceAssets[0].transcript}</p>
              <audio controls preload="none" aria-label="Voice preview" className="w-full" src={audioUrl(`voice-profiles/${selected.id}/source/${selected.sourceAssets[0].filename}`)}><track kind="captions" /></audio>
            </div>}
            {!selected.sourceAssets?.length && <p className="text-sm text-gray-400">This legacy profile has no saved reference preview.</p>}
            <p className="text-xs text-gray-500">Seed {selected.inference?.seed} · Pitch {selected.inference?.pitchSemitones || 0} semitones · Preview pace {selected.inference?.rate || 1}×</p>
            <Link className="inline-flex text-sm text-port-accent" to={`/voices/new?${new URLSearchParams({ ...Object.fromEntries(params), from: selected.id })}`}>Adjust this voice as a new candidate</Link>
            <VoiceAssignment key={`${selected.id}:${universeId}:${characterId}`} profile={selected} universeId={universeId} character={character} onAssigned={putProfile} />
          </div> : profileId && !library.loading && !library.error ? <p role="alert">Voice not found. Select another voice from the library.</p> :
            <p className="text-sm text-gray-400">Select a voice to listen and assign, or create a new character voice.</p>}
      </section>
    </div>
      </div>
      </div>
    </div>
  );
}

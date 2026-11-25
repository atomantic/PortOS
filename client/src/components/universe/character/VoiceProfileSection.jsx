import { Fragment, useEffect, useRef, useState } from 'react';
import { WandSparkles, Loader2, Activity, Mic, BadgeCheck, Play } from 'lucide-react';
import useAsyncAction from '../../../hooks/useAsyncAction';
import { listVoiceEngines, listVoiceProfiles, promoteVoicePreset, renderVoiceProfileBenchmark, createVoiceDesignCandidate, createClonedVoiceCandidate, promoteVoiceProfile, deleteVoiceProfile } from '../../../services/apiVoice';
import { prepareProfilePlayback } from '../../../services/voiceProfileBenchmark';
import VoiceFineTuningPanel from '../../voice/VoiceFineTuningPanel';
import TabPills from '../../ui/TabPills';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import DraftNumber from '../../ui/DraftNumber';
import useDrawerTab from '../../../hooks/useDrawerTab';
import BoxedSection from './BoxedSection';

const VOICE_LAB_TABS = [
  { id: 'overview', label: 'Overview', icon: BadgeCheck },
  { id: 'design', label: 'Design', icon: WandSparkles },
  { id: 'clone', label: 'Clone', icon: Mic },
  { id: 'finetune', label: 'Fine-Tuning', icon: Activity },
];
const VOICE_LAB_TAB_IDS = VOICE_LAB_TABS.map((tab) => tab.id);

export default function VoiceProfileSection({ universeId, entry, disabled }) {
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(Boolean(universeId));
  const [loadError, setLoadError] = useState(null);
  const [_engineCapability, setEngineCapability] = useState(null);
  const [activeTab, setActiveTab] = useDrawerTab(`voiceLab-${entry?.id}`, 'overview', VOICE_LAB_TAB_IDS);

  // Voice Design form state
  const [designInstructions, setDesignInstructions] = useState('');
  const [designSeed, setDesignSeed] = useState(42);
  const [designRate, setDesignRate] = useState(1.0);

  // Consented Cloning form state
  const [cloneFile, setCloneFile] = useState(null);
  const [cloneFileName, setCloneFileName] = useState('');
  const [cloneTranscript, setCloneTranscript] = useState('');
  const [cloneConsentConfirmed, setCloneConsentConfirmed] = useState(false);
  const [cloneLicensePosture, _setCloneLicensePosture] = useState('consented-performance');

  const loadGeneration = useRef(0);

  const refreshProfiles = async () => {
    if (!universeId || !entry?.id) return;
    const result = await listVoiceProfiles({ universeId, characterId: entry.id }, { silent: true });
    const list = Array.isArray(result?.profiles) ? result.profiles : [];
    setProfiles(list);
    const active = list.find((p) => p.approval?.status === 'approved') || list[0] || null;
    if (active) setProfile(active);
  };

  useEffect(() => {
    let cancelled = false;
    const generation = ++loadGeneration.current;
    if (!universeId || !entry?.id) {
      setProfile(null);
      setProfiles([]);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    listVoiceProfiles({ universeId, characterId: entry.id }, { silent: true })
      .then((result) => {
        if (cancelled || generation !== loadGeneration.current) return;
        const list = Array.isArray(result?.profiles) ? result.profiles : [];
        setProfiles(list);
        const active = list.find((p) => p.approval?.status === 'approved') || list[0] || null;
        setProfile(active);
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled && generation === loadGeneration.current) {
          setLoadError(err?.message || 'Failed to load voice profiles');
        }
      })
      .finally(() => {
        if (!cancelled && generation === loadGeneration.current) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [universeId, entry?.id]);

  useEffect(() => {
    if (!universeId) return undefined;
    let cancelled = false;
    listVoiceEngines({ silent: true })
      .then((result) => {
        if (cancelled) return;
        const engine = entry?.voiceId?.split(':')[0] || 'qwen3-tts';
        setEngineCapability((result?.engines || []).find((item) => item.id === engine) || null);
      })
      .catch(() => {
        if (!cancelled) setEngineCapability(null);
      });
    return () => { cancelled = true; };
  }, [universeId, entry?.voiceId]);

  const [promotePreset, promotingPreset] = useAsyncAction(async () => {
    loadGeneration.current += 1;
    const result = await promoteVoicePreset({
      universeId,
      characterId: entry.id,
      characterName: entry.name || '',
      voiceId: entry.voiceId,
    }, { silent: true });
    setProfile(result?.profile || null);
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Could not promote preset' });

  const [designVoice, designingVoice] = useAsyncAction(async () => {
    const result = await createVoiceDesignCandidate({
      universeId,
      characterId: entry.id,
      characterName: entry.name || '',
      instructions: designInstructions,
      seed: designSeed,
      rate: designRate,
    }, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Voice design candidate generation failed' });

  const [cloneVoice, cloningVoice] = useAsyncAction(async () => {
    if (!cloneFile || !cloneConsentConfirmed) return null;
    const arrayBuffer = await cloneFile.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const audioBase64 = btoa(binary);

    const result = await createClonedVoiceCandidate({
      universeId,
      characterId: entry.id,
      characterName: entry.name || '',
      filename: cloneFileName || cloneFile.name || 'reference.wav',
      audioBase64,
      transcript: cloneTranscript,
      performerConsentConfirmed: cloneConsentConfirmed,
      licensePosture: cloneLicensePosture,
    }, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Consented cloning candidate creation failed' });

  const [renderBenchmark, renderingBenchmark] = useAsyncAction(async () => {
    if (!profile?.id) return null;
    const result = await renderVoiceProfileBenchmark(profile.id, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Could not render voice benchmark' });

  const [pendingPlayback, setPendingPlayback] = useState(null);
  const playbackReady = pendingPlayback?.profileId === profile?.id && pendingPlayback?.profileRevision === profile?.version;
  const [qualifyInteractive, qualifyingInteractive] = useAsyncAction(async () => {
    if (!profile?.id) return null;
    if (!playbackReady) {
      const probe = await prepareProfilePlayback(profile.id, { maxFirstAudioMs: 900 }, { silent: true });
      setPendingPlayback(probe);
      return probe;
    }
    setPendingPlayback(null);
    const result = await pendingPlayback.play();
    setProfile(result?.profile || null);
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Interactive benchmark qualification failed' });

  const [promoteSelected, promotingSelected] = useAsyncAction(async (targetProfileId) => {
    const result = await promoteVoiceProfile(targetProfileId, {}, { silent: true });
    await refreshProfiles();
    return result;
  }, { errorMessage: 'Could not promote candidate profile' });

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [removeProfile, removingProfile] = useAsyncAction(async (targetProfileId) => {
    loadGeneration.current += 1;
    await deleteVoiceProfile(targetProfileId, { silent: true });
    setConfirmDeleteId(null);
    if (profile?.id === targetProfileId) setProfile(null);
    await refreshProfiles();
  }, { errorMessage: 'Could not delete voice profile' });

  if (!universeId) return null;
  const approved = profile?.approval?.status === 'approved';
  const _benchmarkCount = profile?.benchmark?.lines?.length || 0;
  const profileState = approved ? `approved v${profile.version} (${profile.kind})` : profile?.approval?.status || 'not promoted';

  return (
    <BoxedSection icon={Mic} label="Local voice profile & Voice Lab" summary={loading ? 'loading' : profileState}>

      <p className="text-[10px] leading-snug text-gray-500">
        Machine-local voice design, consented cloning, and optional fine-tuning. Candidate profiles never mutate approved character voice until explicitly promoted.
      </p>
      {loadError ? <p className="text-[10px] text-port-error">{loadError}</p> : null}

      <TabPills tabs={VOICE_LAB_TABS} activeTab={activeTab} onChange={setActiveTab}
        variant="pills" size="sm" mobileCompact ariaLabel="Voice Lab" />

      {activeTab === 'overview' && (
        <div className="space-y-2">
          {approved ? (
            <div className="rounded border border-port-border/40 bg-port-bg/40 p-2 space-y-1">
              <p className="text-[11px] text-gray-300 font-medium">
                Active Approved Voice: <span className="text-port-accent">{profile.voiceId}</span> ({profile.kind})
              </p>
              <p className="text-[10px] text-gray-400">
                Model: {profile.modelRevision} · Rate: {profile.delivery?.rate ?? 1} · Studio: {profile.routes?.studio?.enabled ? 'Yes' : 'No'} · Interactive: {profile.engine === 'auk' ? (profile.routes?.interactive?.enabled ? 'Buffered enabled' : 'Studio only') : (profile.routes?.interactive?.enabled ? 'Qualified' : 'Pending qualification')}
              </p>
              {profile.benchmark?.interactiveLatencyMs ? (
                <p className="text-[10px] text-port-success">
                  {profile.benchmark.interactiveMeasurement?.boundary === 'browser-playing-segmented' ? 'Render + playback-start benchmark:' : 'Buffered synthesis benchmark:'} {profile.benchmark.interactiveLatencyMs}ms (threshold: {profile.routes?.interactive?.maxFirstAudioMs || 900}ms)
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-[10px] text-gray-500">Promote the selected Piper preset to give this character a stable local voice.</p>
          )}

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button" onClick={promotePreset} disabled={disabled || promotingPreset || !entry.voiceId}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
            >
              <BadgeCheck size={10} /> {approved ? 'Re-promote selected preset' : 'Promote selected preset'}
            </button>
            <button
              type="button" onClick={renderBenchmark} disabled={disabled || renderingBenchmark || !approved}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
            >
              {renderingBenchmark ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />} Render fixed benchmark
            </button>
            <button
              type="button" onClick={qualifyInteractive} disabled={disabled || qualifyingInteractive || !approved}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
            >
              {qualifyingInteractive ? <Loader2 size={10} className="animate-spin" /> : <Activity size={10} />} {playbackReady ? 'Play benchmark to qualify' : 'Qualify interactive route'}
            </button>
          </div>

          {profile?.benchmark?.lines?.length ? (
            <div className="space-y-1.5">
              <p className="text-[10px] text-gray-500">Fixed benchmark renders</p>
              {profile.benchmark.lines.map((line, index) => (
                <div key={line.filename} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-[10px] text-gray-600">{index + 1}</span>
                  <span className="w-20 shrink-0 text-[10px] text-gray-400 truncate">{line.key}</span>
                  <audio
                    controls
                    preload="none"
                    src={`/data/${line.filename.split('/').map(encodeURIComponent).join('/')}`}
                    aria-label={`Voice benchmark ${line.key || index + 1}`}
                    className="h-7 min-w-0 flex-1"
                  >
                    <track kind="captions" />
                  </audio>
                </div>
              ))}
            </div>
          ) : null}

          {/* Candidate & Historical Profiles */}
          {(profiles.length > 1 || profiles.some((p) => p.kind === 'cloned')) && (
            <div className="space-y-1 pt-2 border-t border-port-border/40">
              <p className="text-[10px] text-gray-500 font-medium">Candidate & Previous Profiles</p>
              {profiles.map((p) => (
                <Fragment key={p.id}>
                <div className="flex items-center justify-between gap-2 p-1 text-[10px] border border-port-border/30 rounded">
                  <div className="min-w-0 truncate">
                    <span className="font-semibold text-gray-300">{p.voiceId}</span> ({p.kind}, v{p.version}, {p.approval?.status})
                  </div>
                  {p.approval?.status !== 'approved' ? (
                    <button
                      type="button"
                      onClick={() => promoteSelected(p.id)}
                      disabled={disabled || promotingSelected}
                      className="px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent hover:text-white"
                    >
                      Promote
                    </button>
                  ) : (
                    <span className="text-port-success font-medium">Active</span>
                  )}
                  {p.kind === 'cloned' && confirmDeleteId !== p.id ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(p.id)}
                      disabled={disabled || removingProfile}
                      className="px-1.5 py-0.5 rounded border border-port-border text-gray-400 hover:text-port-error hover:border-port-error"
                    >
                      Delete recording
                    </button>
                  ) : null}
                </div>
                {p.kind === 'cloned' && confirmDeleteId === p.id ? (
                  <InlineConfirmRow
                    question="Delete this cloned voice, its recording and transcript? Rendered dialogue is kept."
                    confirmText="Delete"
                    onConfirm={() => removeProfile(p.id)}
                    onCancel={() => setConfirmDeleteId(null)}
                    autoFocus
                    aria-label="Confirm deleting cloned voice recording"
                  />
                ) : null}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'design' && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-400">Design an original character voice via natural language instructions and seed controls (Qwen3-TTS 1.7B Voice Design).</p>
          <div className="space-y-1.5">
            <label className="block text-[10px] text-gray-400">
              Voice Description & Delivery Instructions
              <input
                type="text"
                value={designInstructions}
                onChange={(e) => setDesignInstructions(e.target.value)}
                placeholder="e.g. warm low alto; dry texture; controlled breath; intimate"
                className="w-full mt-0.5 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
              />
            </label>
            <div className="flex gap-2">
              <label className="block text-[10px] text-gray-400 flex-1">
                Seed
                <DraftNumber integer value={designSeed} onCommit={setDesignSeed}>
                  {(field) => (
                    <input
                      type="number"
                      {...field}
                      className="w-full mt-0.5 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
                    />
                  )}
                </DraftNumber>
              </label>
              <label className="block text-[10px] text-gray-400 flex-1">
                Rate Multiplier ({designRate}x)
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={designRate}
                  onChange={(e) => setDesignRate(parseFloat(e.target.value))}
                  className="w-full mt-0.5"
                />
              </label>
            </div>
          </div>
          <button
            type="button"
            onClick={designVoice}
            disabled={disabled || designingVoice}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-40"
          >
            {designingVoice ? <Loader2 size={12} className="animate-spin" /> : <WandSparkles size={12} />}
            Design Candidate Voice
          </button>
        </div>
      )}

      {activeTab === 'clone' && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-400">Rapid single-speaker cloning with documented consent. Audio remains strictly machine-local.</p>
          <div className="space-y-1.5">
            <label className="block text-[10px] text-gray-400">
              Reference Audio File (WAV/MP3)
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setCloneFile(f || null);
                  setCloneFileName(f?.name || '');
                }}
                className="w-full mt-0.5 text-xs text-gray-300"
              />
            </label>
            <label className="block text-[10px] text-gray-400">
              Audio Transcription
              <textarea
                value={cloneTranscript}
                onChange={(e) => setCloneTranscript(e.target.value)}
                placeholder="Exact spoken words in the recording for conditioning alignment..."
                rows={2}
                className="w-full mt-0.5 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-gray-300">
              <input
                type="checkbox"
                checked={cloneConsentConfirmed}
                onChange={(e) => setCloneConsentConfirmed(e.target.checked)}
              />
              <span>I confirm the performer consented to this voice clone and PortOS keeps this audio machine-local.</span>
            </label>
          </div>
          <button
            type="button"
            onClick={cloneVoice}
            disabled={disabled || cloningVoice || !cloneFile || !cloneConsentConfirmed}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-40"
          >
            {cloningVoice ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />}
            Create Cloned Candidate
          </button>
        </div>
      )}

      {activeTab === 'finetune' && (
        <VoiceFineTuningPanel
          profileId={profile?.id || null}
          disabled={disabled}
          activeModelRevision={approved && profile.kind === 'fine-tuned' ? profile.modelRevision : null}
          onPromoted={refreshProfiles}
        />
      )}
    </BoxedSection>
  );
}

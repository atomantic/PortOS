/**
 * TrackWaveformHost — the Tracks editor's "Drawn waveform" mode (#8376).
 *
 * Hosts the Music Designer's `WaveformPanel` on a saved track so a drawn take
 * can be revised and re-rendered where the track lives: the panel opens on the
 * track's stored `waveSketch`, and draws from the editor's prompt/lyrics. The
 * designer owns its provider picker; this host supplies its own.
 */

import { useState } from 'react';
import useProviderModels from '../../hooks/useProviderModels';
import ProviderModelSelector from '../ProviderModelSelector';
import WaveformPanel from './WaveformPanel';

export default function TrackWaveformHost({ track, description, lyrics, title, onTrackUpdate }) {
  const [effort, setEffort] = useState('');
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading,
  } = useProviderModels({ silent: true, withEffort: true });

  return (
    <WaveformPanel
      key={track.id}
      trackId={track.id}
      track={track}
      description={description}
      lyrics={lyrics}
      title={title}
      providerId={selectedProviderId}
      model={selectedModel}
      effort={effort}
      providerPicker={(
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          availableModels={availableModels}
          onProviderChange={(pid) => { setSelectedProviderId(pid); setEffort(''); }}
          onModelChange={setSelectedModel}
          effort={effort}
          onEffortChange={setEffort}
          disabled={providersLoading}
          layout="stacked"
        />
      )}
      onTrackUpdate={onTrackUpdate}
      onRendered={onTrackUpdate}
    />
  );
}

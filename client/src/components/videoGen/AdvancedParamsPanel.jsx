import { useId } from 'react';
import VideoTimingChainingFields from './VideoTimingChainingFields.jsx';
import VideoSamplerMemoryFields from './VideoSamplerMemoryFields.jsx';
import VideoConditioningAudioFields from './VideoConditioningAudioFields.jsx';

const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

// Shared by Video Gen and the retry editor. Each caller owns its draft values.
export default function AdvancedParamsPanel({ mode, currentModel, timing, samplerMemory, conditioningAudio }) {
  const idPrefix = useId();
  const fieldId = (id) => `${idPrefix}-${id}`;
  const { chainingActive, contextFrames } = timing;

  return (
    <div className="border-t border-port-border pt-3 space-y-3">
      <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Advanced</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <VideoTimingChainingFields {...timing} mode={mode} currentModel={currentModel} fieldId={fieldId} inputCls={inputCls} />
        <VideoSamplerMemoryFields {...samplerMemory} mode={mode} currentModel={currentModel} fieldId={fieldId} inputCls={inputCls}
          chainingActive={chainingActive} contextFrames={contextFrames} />
        <VideoConditioningAudioFields {...conditioningAudio} mode={mode} currentModel={currentModel} fieldId={fieldId} inputCls={inputCls} />
      </div>
    </div>
  );
}

import { patchAvatarChannel } from '../../services/apiVoiceAvatar';
import ChoiceChip from './ChoiceChip';
import VoiceLlmQuickPicker from './VoiceLlmQuickPicker';
import { activeChannelOf, channelLlm, useAvatarLibrary } from './useAvatarLibrary';

/**
 * The Voice brain picker for the on-air channel. "All channels" edits the global voice
 * LLM; "CHn only" gives that channel its own LLM, starting from the current one.
 */
export default function ChannelBrainPicker({ compact = false, globalProvider, globalModel, onGlobalSaved }) {
  const { data: library, updateData } = useAvatarLibrary();
  const channel = activeChannelOf(library);
  const llm = channelLlm(channel, globalProvider, globalModel);
  const number = channel ? channel.index + 1 : null;

  const saveAgent = (agent) => patchAvatarChannel(channel.index, { agent }, { silent: true }).then(updateData);
  // Only the LLM fields are sent; the server merges them into the channel's other overrides.
  const saveOwn = ({ provider, model }) => saveAgent({ provider, model });
  const useGlobal = () => { saveAgent({ provider: null }).catch(() => {}); };

  return (
    <VoiceLlmQuickPicker
      compact={compact}
      provider={llm.provider}
      model={llm.model}
      onSave={llm.own ? saveOwn : undefined}
      onSaved={llm.own ? undefined : onGlobalSaved}
    >
      {channel && (
        <div role="group" aria-label="Voice brain applies to" className="flex flex-wrap gap-1.5">
          <ChoiceChip pressed={!llm.own} onClick={llm.own ? useGlobal : undefined} title="Edit the LLM every channel without its own uses">
            All channels
          </ChoiceChip>
          <ChoiceChip
            pressed={llm.own}
            onClick={llm.own ? undefined : () => saveOwn({ provider: llm.provider, model: llm.model }).catch(() => {})}
            title={`Give channel ${number} its own LLM`}
          >
            {`CH${number} only`}
          </ChoiceChip>
        </div>
      )}
    </VoiceLlmQuickPicker>
  );
}

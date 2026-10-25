/** Retained adapter link for catalog and universe subjects; never creates training data. */

import { useCallback } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import { getCharacterLoras } from '../../services/api';
import useListResource from '../../hooks/useListResource';
import ListLoadError from '../ui/ListLoadError';

export default function CharacterLoraChip({ entryId, ingredientId }) {
  const fetchLoras = useCallback(
    () => getCharacterLoras({ entryId, ingredientId }, { silent: true }),
    [entryId, ingredientId],
  );
  const {
    items: loras,
    state: lorasState,
    error: lorasError,
    retry: retryLoras,
  } = useListResource(fetchLoras, {
    enabled: Boolean(entryId || ingredientId),
  });

  const lora = loras?.[0] || null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      {lorasState === 'error' && (
        <ListLoadError what="character LoRAs" error={lorasError} onRetry={retryLoras} />
      )}
      {lora && (
        <Link
          to="/models/loras"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-port-success/15 text-port-success border border-port-success/30 hover:bg-port-success/25"
          title={`Trained LoRA: ${lora.filename}${lora.triggerWords?.[0] ? ` · trigger: ${lora.triggerWords[0]}` : ''}`}
        >
          <Sparkles className="w-3 h-3" />
          LoRA{lora.triggerWords?.[0] ? ` · ${lora.triggerWords[0]}` : ''}
        </Link>
      )}
    </div>
  );
}

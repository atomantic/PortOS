import { useAsyncAction } from '../../hooks/useAsyncAction';

function generationFailureMessage(reason) {
  switch (reason) {
    case 'no_provider': return 'No AI provider is available. Configure an AI provider and try again.';
    case 'no_data': return 'There is no data to analyze yet.';
    case 'no_taste_data': return 'Complete your taste profile before generating identity themes.';
    case 'invalid_response': return 'The AI provider returned themes in a format PortOS could not read. Try again or pick another model.';
    case 'not_computed': return 'Compute a goal scorecard before generating its narrative.';
    case 'no_activity': return 'There is no tracked activity for this scorecard.';
    case 'generation_failed': return 'The AI provider did not generate a scorecard narrative.';
    default: return reason;
  }
}

export function useInsightGeneration(generate, onSuccess, errorMessage) {
  return useAsyncAction(async () => {
    const result = await generate(undefined, undefined, { silent: true });
    if (result?.available !== true) {
      throw new Error(generationFailureMessage(result?.reason) || errorMessage);
    }
    onSuccess(result);
  }, { errorMessage });
}

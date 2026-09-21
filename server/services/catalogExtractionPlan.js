import { resolveStageContext } from './stageRunner.js';
import { buildPrompt } from './promptService.js';
import { estimateTokens, usableInputTokens, FALLBACK_CONTEXT_WINDOW, CHARS_PER_TOKEN } from '../lib/contextBudget.js';
import { chunkRawText } from '../lib/catalogChunking.js';
import { neutralizeFences } from '../lib/promptFencing.js';
import { countWords } from '../lib/textUtils.js';
import { RELATION_KIND_IDS } from '../lib/catalogTypes.js';
import { ServerError } from '../lib/errorHandler.js';

export const CATALOG_EXTRACTION_STAGE = 'catalog-extract';

/** Plan against the resolved route and retain the EXACT prompts we budgeted. */
export async function planCatalogExtraction({ rawText, context, providerOverride, modelOverride }) {
  const route = await resolveStageContext('catalog-extract', { providerOverride, modelOverride });
  const knownWindow = Number(route.contextWindow);
  const knownCapacity = Number.isFinite(knownWindow) && knownWindow > 0;
  const contextWindow = knownCapacity ? knownWindow : FALLBACK_CONTEXT_WINDOW;
  const outputReserveTokens = Math.min(8000, Math.floor(contextWindow / 4));
  const inputBudget = usableInputTokens({ contextWindow, outputReserveTokens });
  const render = body => buildPrompt('catalog-extract', {
    work: { title: neutralizeFences(context.title), kind: neutralizeFences(context.sourceKind), wordCount: countWords(body) },
    factual: context.factual === true,
    draftBody: neutralizeFences(body),
    relationKinds: RELATION_KIND_IDS.join(', '),
    returnsJson: true,
  });
  // buildPrompt includes the creative policy and installed/customized template.
  // A stored 12K child row is a persistence detail, not a context limitation.
  const whole = await render(rawText);
  let parts = [{ text: rawText, prompt: whole }];
  if (estimateTokens(whole) > inputBudget) {
    const fixedTokens = estimateTokens(await render(''));
    let maxChars = Math.floor((inputBudget - fixedTokens) * CHARS_PER_TOKEN);
    while (true) {
      if (maxChars < 1) throw new ServerError('The catalog prompt and output reserve do not fit this model. Choose a larger context or shorten the prompt.', { status: 422, code: 'CATALOG_CONTEXT_TOO_SMALL' });
      // Infinity removes the storage splitter's max-chunks remainder behavior:
      // every character survives, and NO final chunk may exceed the budget.
      const texts = chunkRawText(rawText, { maxChars, maxChunks: Infinity });
      parts = [];
      for (const body of texts) parts.push({ text: body, prompt: await render(body) });
      if (parts.every(part => estimateTokens(part.prompt) <= inputBudget)) break;
      // A customized template may repeat draftBody or change word-count width.
      // Verify actual renders rather than assuming a single interpolation.
      maxChars = Math.floor(maxChars / 2);
    }
  }
  let offset = 0;
  const chunks = parts.map((part, index) => {
    const chunk = { index, id: parts.length === 1 ? 'catalog' : `catalog-${index + 1}`,
      label: parts.length === 1 ? 'Catalog graph' : `Catalog graph — part ${index + 1} of ${parts.length}`,
      startChar: offset, endChar: offset + part.text.length, inputTokens: estimateTokens(part.prompt),
    };
    offset = chunk.endChar;
    return chunk;
  });
  return {
    parts,
    options: { providerOverride: route.provider.id, modelOverride: route.model, allowFallback: false,
      returnsJson: false, maxTokens: outputReserveTokens, source: 'catalog-extract' },
    plan: { mode: parts.length === 1 ? 'whole' : 'chunked', providerId: route.provider.id, model: route.model,
      contextWindow, unknownCapacity: !knownCapacity, outputReserveTokens, inputBudget,
      sourceChars: rawText.length, chunks },
  };
}

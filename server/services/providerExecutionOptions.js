import { createHash } from 'node:crypto';
import { getProviderById, createProvider } from './providers.js';
import { resolveExecutionOptions, executionOptionsError } from '../lib/executionOptions.js';
import { prepareExecutionOptions } from '../lib/providerExecutionOptions.js';
export { getExecutionOptionCapabilities, prepareExecutionOptions } from '../lib/providerExecutionOptions.js';

let selectionWriteTail = Promise.resolve();

/** A real preset reference keeps legacy selectors and saved jobs lossless. */
export function createExecutionOptionSelection(providerId, model, executionOptions) {
  const write = selectionWriteTail.then(async () => {
    let source = await getProviderById(providerId);
    if (!source) throw executionOptionsError('Execution selection source was not found');
    if (source.executionSourceProviderId) source = await getProviderById(source.executionSourceProviderId);
    if (!source) throw executionOptionsError('Execution selection source is unavailable');
    const options = resolveExecutionOptions({ source: 'selection', options: executionOptions }).requested;
    if (!Object.keys(options).length) return source;
    await prepareExecutionOptions(source, model, options, 'selection');
    if (source.id.includes('@')) {
      const rootId = `selection-source-${createHash('sha256').update(source.id).digest('hex').slice(0, 20)}`;
      source = await getProviderById(rootId) || await createProvider({ ...source, apiKey: source.apiKey ?? '',
        id: rootId, executionSelectionRoot: true });
    }

    const digest = createHash('sha256').update(JSON.stringify([source.id, Object.entries(options).sort()])).digest('hex').slice(0, 24);
    const id = `selection-${digest}`;
    const existing = await getProviderById(id);
    if (existing) {
      if (existing.executionSourceProviderId !== source.id || JSON.stringify(existing.executionSelectionOptions ?? existing.executionOptions) !== JSON.stringify(options)) throw executionOptionsError('Execution selection id conflicts with another provider');
      return existing;
    }
    // Persist the ordinary preset snapshot for older installs; current readers resolve the source on each read.
    await createProvider({ ...source, apiKey: source.apiKey ?? '', id, name: `${source.name} (${Object.values(options).join(', ')} requested)`,
      enabled: true, executionSourceProviderId: source.id, executionOptions: options });
    return getProviderById(id);
  });
  selectionWriteTail = write.catch(() => {});
  return write;
}

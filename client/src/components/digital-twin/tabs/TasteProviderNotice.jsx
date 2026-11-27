import { Link } from 'react-router';
import Banner from '../../ui/Banner';
import ListLoadError from '../../ui/ListLoadError';

export const NO_API_PROVIDER_TITLE = 'Configure an AI provider to enable';

export default function TasteProviderNotice({ providersResource, selectedProvider, actionLabel }) {
  return (
    <>
      {providersResource.state === 'error' && (
        <ListLoadError className="mb-4" what="AI providers" error={providersResource.error} onRetry={providersResource.retry} />
      )}
      {!selectedProvider && providersResource.state === 'ready' && (
        <Banner tone="warning" size="lg" className="mb-4">
          No API-based provider configured — {actionLabel}.{' '}
          <Link to="/ai" className="underline hover:text-yellow-300">
            Open AI Providers
          </Link>{' '}
          and add LM Studio, OpenAI, or Anthropic to enable AI generation.
        </Banner>
      )}
    </>
  );
}

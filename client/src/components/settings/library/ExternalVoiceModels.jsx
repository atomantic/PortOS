import { Link } from 'react-router';
import { CONVERSATIONAL_GEMMA } from '../../../../../server/lib/voiceModelCatalog.js';
import { PROVIDERS_PAGE_BREADCRUMB, PROVIDERS_PAGE_PATH } from '../../../../../server/lib/navManifest.js';

export default function ExternalVoiceModels() {
  const { name, url, license } = CONVERSATIONAL_GEMMA;
  return (
    <details className="rounded-lg border border-port-border px-3 py-2">
      <summary className="cursor-pointer py-2 text-sm font-medium">Externally served voice models</summary>
      <article className="space-y-2 pb-2 pt-1 text-sm">
        <h3 className="font-medium">{name}</h3>
        <p className="text-port-text-muted">
          Trelis tuned this English text model for natural spoken replies and tool calls, not speech synthesis.
          The published FP8 weights need a compatible CUDA GPU with enough VRAM. PortOS does not install them through Ollama or LM Studio.
        </p>
        <p className="text-port-text-muted">
          <a href={url} target="_blank" rel="noreferrer" className="text-port-accent hover:underline">Model card and access</a>
          {' · '}{license}. Serve it with your own compatible OpenAI API, then add it under{' '}
          <Link to={PROVIDERS_PAGE_PATH} className="text-port-accent hover:underline">{PROVIDERS_PAGE_BREADCRUMB}</Link>.
        </p>
      </article>
    </details>
  );
}

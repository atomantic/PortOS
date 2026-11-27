import { useState } from 'react';
import { checkConversationalGemmaAccess } from '../../../services/apiLocalLlm.js';
import HfTokenBanner from '../../imageGen/HfTokenBanner.jsx';
import { Link } from 'react-router';
import { CONVERSATIONAL_GEMMA } from '../../../../../server/lib/voiceModelCatalog.js';
import { PROVIDERS_PAGE_BREADCRUMB, PROVIDERS_PAGE_PATH } from '../../../../../server/lib/navManifest.js';

export default function ExternalVoiceModels() {
  const { name, url, license, localGgufPath } = CONVERSATIONAL_GEMMA;
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    setStatus(null);
    try {
      setStatus((await checkConversationalGemmaAccess({ silent: true })).status);
    } catch {
      setStatus('error');
    } finally {
      setChecking(false);
    }
  };
  return (
    <details className="rounded-lg border border-port-border px-3 py-2">
      <summary className="cursor-pointer py-2 text-sm font-medium">Externally served voice models</summary>
      <article className="space-y-2 pb-2 pt-1 text-sm">
        <h3 className="font-medium">{name}</h3>
        <p className="text-port-text-muted">
          Trelis tuned this English text model for natural spoken replies and tool calls, not speech synthesis.
          The published FP8 weights target CUDA. A locally converted Q8_0 GGUF can instead be launched on Apple Silicon with llama.cpp.
          PortOS does not download a ready-made Ollama or LM Studio build.
        </p>
        <p className="text-port-text-muted">
          <a href={url} target="_blank" rel="noreferrer" className="text-port-accent hover:underline">Model card and access</a>
          {' · '}{license}. Serve it with your own compatible OpenAI API, then add it under{' '}
          <Link to={PROVIDERS_PAGE_PATH} className="text-port-accent hover:underline">{PROVIDERS_PAGE_BREADCRUMB}</Link>.
        </p>
        <p className="text-port-text-muted">
          For a local conversion, put the GGUF at <code className="break-all">{localGgufPath}</code>.
          Its preset appears in the <Link to="/models/llms-runtimes" className="text-port-accent hover:underline">llama.cpp runtime</Link> once the file is present.
        </p>
        <button type="button" disabled={checking} onClick={check}
          className="min-h-11 rounded-lg border border-port-border px-3 text-sm hover:border-port-accent disabled:opacity-50">
          {checking ? 'Checking download access…' : status ? 'Recheck download access' : 'Check download access'}
        </button>
        {status === 'ready' && <p role="status" className="text-port-success">Hugging Face confirmed access to the checkpoint.</p>}
        {status === 'terms-required' && <p role="status" className="text-port-warning">
          Hugging Face denied access. Accept the terms using the account that owns your read token, and check that the token allows gated repositories.
        </p>}
        {status === 'error' && <p role="alert" className="text-port-error">Could not verify Hugging Face access. Try again shortly.</p>}
        {(status === 'token-required' || status === 'terms-required') && (
          <HfTokenBanner modelLabel={name} licenseUrl={url} onSaved={check} />
        )}
      </article>
    </details>
  );
}

// Selected-model disclosure (#3674) — what runs where, under whose terms.
//
// Renders factual, server-sourced metadata for the selected backend/model:
// local vs hosted execution + policy scope, model card / pinned revision,
// weights and runtime licenses, download size, memory requirement vs this
// system, supported modes and runtime name.
//
// Two rules this component exists to hold:
//   - A fact the registry does not carry renders as "Unknown". It is NEVER
//     derived from the model's display name, its repo slug, or a sibling model.
//   - Backend wording is rendered verbatim from the server payload
//     (`status.backendDisclosures`), so the policy-scope language lives in one
//     place (server/lib/videoDisclosure.js) and can't drift here.
//
// It is deliberately NOT part of `ModelSelect` — that component selects models
// and must stay a plain picker. Territory exclusions (when a model declares
// them) render here as facts next to the weights license, not as a blocking
// acknowledgement.
import { Server, Cloud } from 'lucide-react';
import FactLink from './FactLink.jsx';
import { formatDownloadGb } from '../../utils/formatters';
import { VIDEO_MEMORY_RESERVE_GB, selectVideoMemoryProfile } from '../../lib/videoGenParams';

const UNKNOWN = 'Unknown';

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-[11px] text-gray-300 break-words">{children ?? <span className="text-gray-500">{UNKNOWN}</span>}</dd>
    </div>
  );
}

function LicenseFact({ label, license }) {
  return (
    <Fact label={label}>
      {license?.name
        ? (license.url ? <FactLink href={license.url}>{license.name}</FactLink> : license.name)
        : null}
    </Fact>
  );
}

// Minimum unified memory the registry declares for this model, plus how it
// compares to this machine. Both halves are Unknown-safe: an entry with no
// `memoryGb`, or a status payload with no `systemMemoryGb`, says so.
function MemoryFact({ model, systemMemoryGb }) {
  const required = typeof model?.memoryGb === 'number' ? model.memoryGb : null;
  const system = typeof systemMemoryGb === 'number' ? systemMemoryGb : null;
  if (required === null) return <Fact label="Minimum unified memory">{null}</Fact>;
  const fits = system === null ? null : system >= required;
  return (
    <Fact label="Minimum unified memory">
      {required} GB
      {system === null ? (
        <span className="text-gray-500"> · this system: {UNKNOWN}</span>
      ) : (
        <span className={fits ? ' text-port-success' : ' text-port-warning'}>
          {' '}· this system has {system} GB{fits ? '' : ' — below the stated minimum'}
        </span>
      )}
    </Fact>
  );
}

// Which weight-placement profile this machine will actually get, for a model
// that declares them (#5420 — MiniMax H3 today). This is the HONEST capacity
// fact next to the headline `memoryGb`: that number never accounted for the
// reserve PortOS keeps for the OS, so a machine sitting exactly on it read as a
// fit while a render would have taken the whole box. Renders nothing at all for
// a model with no declared profiles, so no other entry gains a row.
function MemoryProfileFact({ model, systemMemoryGb }) {
  const { profile, usableGb, floorGb } = selectVideoMemoryProfile(model, systemMemoryGb);
  if (floorGb === null) return null;
  return (
    <Fact label="Memory profile">
      {usableGb === null ? (
        <>
          Needs {floorGb} GB usable · <span className="text-gray-500">this system: {UNKNOWN}</span>
        </>
      ) : profile ? (
        <span className="text-port-success">
          {profile.name || profile.id} · needs {profile.minMemoryGb} GB usable, this system has {Math.round(usableGb)} GB
          {' '}after the {VIDEO_MEMORY_RESERVE_GB} GB reserve
        </span>
      ) : (
        <span className="text-port-warning">
          None — the smallest profile needs {floorGb} GB usable and this system has {Math.round(usableGb)} GB
          {' '}after the {VIDEO_MEMORY_RESERVE_GB} GB reserve. Renders are refused rather than started.
        </span>
      )}
    </Fact>
  );
}

export default function ModelDisclosure({
  backend = 'local',
  backendDisclosures,
  model,
  systemMemoryGb,
}) {
  const list = Array.isArray(backendDisclosures) ? backendDisclosures : [];
  const backendInfo = list.find((b) => b?.id === backend) || null;
  const hosted = backendInfo?.execution === 'hosted';
  // Model metadata only describes the local registry. On a hosted backend the
  // provider picks the model, so showing local model facts would be wrong.
  const showModelFacts = !hosted && !!model;
  const disclosure = model?.disclosure && typeof model.disclosure === 'object' ? model.disclosure : null;

  if (!backendInfo && !showModelFacts) return null;

  const modes = Array.isArray(model?.supportedModes) && model.supportedModes.length > 0
    ? model.supportedModes.join(', ')
    : null;

  return (
    <details className="bg-port-card border border-port-border rounded-xl overflow-hidden">
      <summary className="cursor-pointer list-none px-3 py-2 text-[11px] text-gray-400 flex flex-wrap items-center gap-x-2 gap-y-1 hover:text-gray-200">
        {hosted
          ? <Cloud className="w-3.5 h-3.5 shrink-0 text-port-warning" aria-hidden="true" />
          : <Server className="w-3.5 h-3.5 shrink-0 text-port-success" aria-hidden="true" />}
        <span className="font-medium text-gray-300">
          {hosted ? 'Hosted' : 'Runs on this machine'}
        </span>
        {showModelFacts && (
          <>
            <span aria-hidden="true">·</span>
            <span>Weights license: {disclosure?.weightsLicense?.name || UNKNOWN}</span>
            <span aria-hidden="true">·</span>
            <span>Download: {formatDownloadGb(disclosure?.estimatedDownloadGb) || UNKNOWN}</span>
          </>
        )}
        <span className="text-gray-500 underline">Details</span>
      </summary>

      <div className="px-3 pb-3 space-y-3 border-t border-port-border/60 pt-2">
        {backendInfo && (
          <section aria-label="Execution and policy scope">
            <p className="text-[11px] text-gray-300">{backendInfo.summary}</p>
            <ul className="mt-1 space-y-0.5 text-[11px] text-gray-400 list-disc pl-4">
              {(backendInfo.facts || []).map((fact) => <li key={fact}>{fact}</li>)}
            </ul>
            {(backendInfo.links || []).length > 0 && (
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                {backendInfo.links.map((link) => (
                  <FactLink key={link.url} href={link.url}>{link.label}</FactLink>
                ))}
              </p>
            )}
          </section>
        )}

        {showModelFacts && (
          <section aria-label="Selected model disclosure">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              <Fact label="Model card / source">
                {disclosure?.modelCardUrl
                  ? <FactLink href={disclosure.modelCardUrl}>{model?.repo || disclosure.modelCardUrl}</FactLink>
                  : (model?.repo || null)}
              </Fact>
              <Fact label="Pinned revision">
                {model?.revision ? <code className="text-gray-400">{model.revision}</code> : null}
              </Fact>
              <LicenseFact label="Weights license" license={disclosure?.weightsLicense} />
              <LicenseFact label="Runtime license" license={disclosure?.runtimeLicense} />
              {Array.isArray(model?.termsGate?.excludedTerritories) && model.termsGate.excludedTerritories.length > 0 && (
                <Fact label="License territory">
                  Excludes {model.termsGate.excludedTerritories.join(', ')}
                </Fact>
              )}
              <Fact label="Estimated download">{formatDownloadGb(disclosure?.estimatedDownloadGb)}</Fact>
              <MemoryFact model={model} systemMemoryGb={systemMemoryGb} />
              <MemoryProfileFact model={model} systemMemoryGb={systemMemoryGb} />
              <Fact label="Supported modes">{modes}</Fact>
              <Fact label="Runtime">{model?.runtime || null}</Fact>
            </dl>
            <p className="mt-2 text-[10px] text-gray-500">
              {disclosure?.reviewedAt
                ? `Disclosure facts checked against upstream sources on ${disclosure.reviewedAt}. `
                : ''}
              &ldquo;{UNKNOWN}&rdquo; means PortOS has no source-backed value — it is not a claim that the fact does not exist.
            </p>
          </section>
        )}
      </div>
    </details>
  );
}

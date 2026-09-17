/**
 * Provider REFERENCE grammar (#7564, epic #7561): the two spellings a
 * `{ providerId, model, effort }` selection may name a provider by.
 *
 *   - a PRESET id — a `data/providers.json` record: `^[a-z0-9][a-z0-9-]*$`
 *     (the same slug `aiToolkit/validation.js#providerSchema.id` mints);
 *   - a COMPOSITE id — `<harness>.<method>@<service-slug>[+<bootstrap-slug>]`,
 *     e.g. `pi.tui@nvidia-nim-free`, `direct.api@ollama`,
 *     `claude.cli@anthropic+corp-auth`: an enabled harness driven in one of its
 *     execution methods against an enabled service instance, materialized at
 *     resolve time and never persisted as a record.
 *
 * The two grammars cannot collide: `.` and `@` are outside the preset
 * alphabet, so a composite is recognizable from the string alone and a preset
 * lookup can never accidentally read one. The `+<bootstrap-slug>` suffix names
 * a credential-bootstrap app (`settings.credentialBootstraps`) and is legal
 * only with a process method (`cli` / `tui`): a direct API call has no spawn
 * for a wrapper to sit in front of.
 *
 * Pure and dependency-free so both the browser and the vendored toolkit
 * (`aiToolkit/internal/providerRef.js`, a deliberate mirror behind
 * `providerRef.parity.test.js`) can carry the same rule.
 */

/** A preset record id — the slug `createProvider` assigns. */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The execution methods a composite may name; mirrors a record's `type`. */
export const COMPOSITE_METHODS = Object.freeze(['cli', 'tui', 'api']);

/**
 * `<harness>.<method>@<service-slug>[+<bootstrap-slug>]`. Groups: harness id,
 * method, service slug, optional bootstrap slug.
 */
export const COMPOSITE_ID_RE = /^([a-z0-9-]+)\.(cli|tui|api)@([a-z0-9][a-z0-9-]*)(?:\+([a-z0-9][a-z0-9-]*))?$/;

/** Longest reference any selection field accepts. */
export const MAX_PROVIDER_REF_LENGTH = 200;

/** The validation message a selection field reports for a malformed reference. */
export const PROVIDER_REF_MESSAGE = 'provider must be a preset id (lowercase alphanumeric with hyphens) or a composite <harness>.<cli|tui|api>@<service-slug>[+<bootstrap-slug>] (the bootstrap suffix only with cli or tui)';

/** The message a PRESET-ONLY field reports when handed a composite. */
export const PRESET_ONLY_MESSAGE = 'must be a preset provider id (lowercase alphanumeric with hyphens); a composite harness.method@service selection is not accepted here';

/**
 * Parse a provider reference.
 *
 * @param {unknown} id
 * @returns {{kind: 'preset', id: string}
 *   | {kind: 'composite', id: string, harnessId: string, method: 'cli'|'tui'|'api', serviceSlug: string, bootstrapSlug: string|null}
 *   | null} `null` for anything that is neither grammar — including a
 *   bootstrap suffix on the `api` method.
 */
export function parseProviderRef(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROVIDER_REF_LENGTH) return null;
  if (PRESET_ID_RE.test(id)) return { kind: 'preset', id };
  const match = COMPOSITE_ID_RE.exec(id);
  if (!match) return null;
  const [, harnessId, method, serviceSlug, bootstrapSlug = null] = match;
  if (bootstrapSlug && method === 'api') return null;
  return { kind: 'composite', id, harnessId, method, serviceSlug, bootstrapSlug };
}

/** Whether `id` is a well-formed composite reference. */
export const isCompositeProviderId = (id) => parseProviderRef(id)?.kind === 'composite';

/** Whether `id` is a well-formed preset record id. */
export const isPresetProviderId = (id) => parseProviderRef(id)?.kind === 'preset';

/**
 * The composite id for its parts. Throws on parts that do not form a valid
 * reference, so a caller can never mint an id `parseProviderRef` rejects.
 *
 * @param {{harnessId: string, method: string, serviceSlug: string, bootstrapSlug?: string|null}} parts
 * @returns {string}
 */
export function formatCompositeId({ harnessId, method, serviceSlug, bootstrapSlug = null }) {
  const id = `${harnessId}.${method}@${serviceSlug}${bootstrapSlug ? `+${bootstrapSlug}` : ''}`;
  if (parseProviderRef(id)?.kind !== 'composite') {
    throw new Error(`"${id}" is not a composite provider id`);
  }
  return id;
}

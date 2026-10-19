// Shared (server + client) classifier for env-var names that conventionally hold
// credentials. The explicit provider `secretEnvVars` list stays the primary
// masking source; this catches hand-entered vars whose Secret box was left off.

const CREDENTIAL_ENV_VAR_RE = /(?:^|_)(?:API_KEY|APIKEY|AUTH|ACCESS_KEY|ACCESS_TOKEN|BEARER|CLIENT_SECRET|CREDENTIALS?|KEY|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i;

const NON_CREDENTIAL_ENV_VAR_RE = /(?:^|_)(?:BASE_URL|CONFIG|CONFIG_CONTENT|ENDPOINT|HOST|MODEL|MODE|PATH|PORT|PROFILE|REGION)(?:_|$)/i;

const NON_CREDENTIAL_ENV_VAR_NAMES = new Set(['CLAUDE_CODE_USE_BEDROCK']);

/** True for names known to hold config, not a credential (AWS_PROFILE, *_BASE_URL…). */
export const isNonCredentialEnvVarName = (name) => typeof name === 'string'
  && (NON_CREDENTIAL_ENV_VAR_NAMES.has(name) || NON_CREDENTIAL_ENV_VAR_RE.test(name));

/** True when the env-var NAME looks like a credential by convention. */
export const isCredentialEnvVarName = (name) => typeof name === 'string'
  && !isNonCredentialEnvVarName(name)
  && CREDENTIAL_ENV_VAR_RE.test(name);

/** Should this provider env var be redacted: listed secret OR credential-named. */
export const isMaskedEnvVar = (name, secretEnvVars) =>
  (Array.isArray(secretEnvVars) && secretEnvVars.includes(name)) || isCredentialEnvVarName(name);

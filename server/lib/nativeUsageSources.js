/** Pure schema for private detached native-source evidence, not a runtime store. */
import { z } from 'zod';

export const NATIVE_USAGE_SOURCE_ROLES = Object.freeze(['codexSessions', 'codexArchivedSessions', 'claudeProjects', 'grokSessions',
  'agyCliConversations', 'agyLegacyBrain', 'agyAppConversations', 'agyIdeConversations']);
export const NATIVE_USAGE_SOURCE_MAX_ENTRIES = 100000;
export const NATIVE_USAGE_SOURCE_MAX_BYTES = 100 * 1024 ** 3;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const roles = z.strictObject(Object.fromEntries(NATIVE_USAGE_SOURCE_ROLES.map(role => [role,
  z.enum(['provided', 'absent-from-detached-input', 'not-supplied/unknown'])])));
export const nativeUsageSourcesRequestSchema = z.strictObject({ version: z.literal(1),
  participantKey: z.string().regex(/^[a-f0-9]{32}$/), reportHash: hash, roles });
export const nativeUsageSourcesSidecarSchema = nativeUsageSourcesRequestSchema.extend({ kind: z.literal('native-usage-sources'), stageHash: hash,
  directories: z.array(z.string()).max(NATIVE_USAGE_SOURCE_MAX_ENTRIES),
  byteLengths: z.record(z.string(), z.number().int().min(0).max(NATIVE_USAGE_SOURCE_MAX_BYTES)) });
export const nativeUsageSourcesManifestSchema = z.strictObject({ generatedAt: z.string(),
  fileCount: z.number().int().min(2).max(NATIVE_USAGE_SOURCE_MAX_ENTRIES + 2), files: z.record(z.string(), hash) });

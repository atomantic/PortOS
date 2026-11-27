// Zod request schemas for the browser routes.

import { z } from 'zod';
import { validateChromePath, validateMacAppBundle } from './browserConfig.js';
import { isSafeIngestUrl } from './safeUrlFetch.js';
import { logsQuerySchema } from './sharedSchemas.js';

// Validation schemas
export const downloadQuerySchema = z.object({ attachment: z.string().optional() });

// Reuses the PM2 logs bound (1..5000) but keeps this route's historical 50-line default.
export const browserLogsQuerySchema = logsQuerySchema.pick({ lines: true }).extend({
  lines: z.coerce.number().int().min(1).max(5000).default(50),
});

// SSRF guard (shared with catalog URL ingest): reject non-http(s) schemes
// (file:/chrome:/javascript:) and loopback / link-local / cloud-metadata host
// LITERALS so an agent-driven navigate can't directly target local-file
// exfiltration or a metadata endpoint. Private/LAN + Tailscale hosts stay
// allowed (a single-user tool legitimately drives its browser there);
// `localhost`/`127.x` are blocked — navigate by LAN IP/hostname for a local app.
// This is the FIRST of three layers — a host-literal guard. The hostname→blocked
// (DNS-rebinding) and post-navigate-redirect gaps it can't see are closed in the
// handler: a DNS-resolve pre-check (`assertPublicHttpUrl`) rejects a hostname
// whose A record points at a blocked address, and the CDP pin
// (`navigateToUrlPinned`) verifies Chrome's ACTUAL per-hop connect IP for the
// initial nav, every redirect, and any settle-window navigation.
export const navigateSchema = z.object({
  url: z.string().url()
    .refine(isSafeIngestUrl, 'only http(s) URLs to non-loopback/non-link-local hosts are allowed')
});

export const restartSchema = z.object({ ticket: z.string().uuid().optional() }).strict();

// Empty string or null from a "clear" UI action → unset (undefined), so the launcher
// falls back to the platform default Chrome instead of trying to spawn "".
const optionalPath = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().max(1024).refine(
    v => !v || !v.includes('..'),
    { message: 'path must not contain path traversal' }
  ).optional()
);

const chromePathSchema = optionalPath.superRefine((value, ctx) => {
  const message = validateChromePath(value);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

const macAppBundleSchema = optionalPath.superRefine((value, ctx) => {
  const message = validateMacAppBundle(value);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

export const updateConfigSchema = z.object({
  cdpPort: z.number().int().min(1024).max(65535).optional(),
  cdpHost: z.enum(['127.0.0.1', 'localhost', '::1']).optional(),
  healthPort: z.number().int().min(1024).max(65535).optional(),
  autoConnect: z.boolean().optional(),
  headless: z.boolean().optional(),
  userDataDir: z.string().optional(),
  downloadDir: z.string().refine(
    v => !v || !v.includes('..'),
    { message: 'downloadDir must not contain path traversal' }
  ).optional(),
  // Custom Chrome binary (e.g. Chrome Canary). When unset, the launcher falls
  // back to the platform default (`/Applications/Google Chrome.app/...` on
  // macOS, `C:\Program Files\Google\Chrome\...` on Windows, `google-chrome`
  // on Linux).
  chromePath: chromePathSchema,
  // macOS headed mode launches via `open -na <app-bundle>` for TCC reasons,
  // so the bundle (`.app`) path is tracked separately from the executable.
  macAppBundle: macAppBundleSchema,
  canaryPromptDeclined: z.boolean().optional()
});

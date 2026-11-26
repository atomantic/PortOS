/**
 * Registers model artifact status, download, repair, and optional integrity verification handlers.
 */

import { asyncHandler, failValidation } from './errorHandler.js';
import { modelDownloadQuerySchema, modelRepairBodySchema, modelVerifyBodySchema } from './sharedSchemas.js';
import { validateRequest } from './validateRequest.js';

export function registerArtifactRoutes(router, {
  mount,
  paramsSchema,
  downloadQuerySchema = modelDownloadQuerySchema,
  resolve,
  resolveStatus = resolve,
  status,
  download,
  repair,
  verify,
}) {
  const downloadParams = (params) => paramsSchema ? validateRequest(paramsSchema, params) : params;

  // Each owner mounts literal paths so the source-derived API catalog can
  // discover the routes without importing the runtime or model registry.
  mount(router, {
    status: asyncHandler(async (req, res) => {
      validateRequest(modelDownloadQuerySchema, req.query);
      res.json(await status(resolveStatus(downloadParams(req.params))));
    }),
    download: asyncHandler(async (req, res) => {
      const query = validateRequest(downloadQuerySchema, req.query);
      await download(resolve(downloadParams(req.params)), { ...query, req, res });
    }),
    repair: asyncHandler(async (req, res) => {
      // Repair resolves the raw route key first. Unknown artifacts and local
      // encoder paths retain their domain error even with a malformed body.
      const artifact = resolve(req.params);
      const parsed = modelRepairBodySchema.safeParse(req.body || {});
      if (!parsed.success) failValidation(parsed);
      const { deep = false } = parsed.data;
      res.json({ deep, ...await repair(artifact, { deep }) });
    }),
    verify: verify && asyncHandler(async (req, res) => {
      const parsed = modelVerifyBodySchema.safeParse(req.body || {});
      if (!parsed.success) failValidation(parsed);
      const { modelId, deep = false } = parsed.data;
      res.json({ deep, models: await verify({ modelId, deep }) });
    }),
  });
}

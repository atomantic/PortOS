import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { festivalPacketSchema } from '../lib/musicVideoFestivalPacket.js';

const router = Router();
router.get('/:id/festival-packet', asyncHandler(async (req, res) => {
  const { getFestivalPacket } = await import('../services/musicVideo/festivalPacket.js');
  res.json(await getFestivalPacket(req.params.id));
}));
router.put('/:id/festival-packet', asyncHandler(async (req, res) => {
  const packet = validateRequest(festivalPacketSchema, req.body);
  const { updateProject } = await import('../services/musicVideo/projects.js');
  const project = await updateProject(req.params.id, { festivalPacket: packet });
  res.json({ packet: project.festivalPacket });
}));
router.post('/:id/festival-packet/preview', asyncHandler(async (req, res) => {
  const packet = validateRequest(festivalPacketSchema, req.body);
  const { previewFestivalPacket } = await import('../services/musicVideo/festivalPacket.js');
  res.json(await previewFestivalPacket(req.params.id, packet));
}));
export default router;

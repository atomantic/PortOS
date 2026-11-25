/**
 * `LOCAL_LLM_BACKENDS` (id/label/lucide icon for Ollama + LM Studio) and `localLlmBackendLabel(id)`.
 *
 * The two backends PortOS keeps a model catalog for, shared by the Runtimes view's backend cards and
 * the Model Library's backend picker so a third backend is added in one place. The qualified names
 * keep generic `BACKENDS` / `labelFor` identifiers out of call sites.
 */

import { Box, Cpu } from 'lucide-react';
import { LOCAL_RUNTIME_LABELS } from '../../../server/lib/modelPinMembership.js';

export const LOCAL_LLM_BACKENDS = [
  { id: 'ollama', label: LOCAL_RUNTIME_LABELS.ollama, icon: Cpu },
  { id: 'lmstudio', label: LOCAL_RUNTIME_LABELS.lmstudio, icon: Box }
];

export const localLlmBackendLabel = (id) => LOCAL_LLM_BACKENDS.find((b) => b.id === id)?.label || id;

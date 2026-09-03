/**
 * The two local-LLM backends PortOS keeps a model catalog for. Shared by the
 * Runtimes view (one card per backend) and the Model Library view (the same
 * list as a picker), so adding a third backend is a one-line change here.
 *
 * Exported under qualified names because `client/src/lib/index.js` is a flat
 * `export *` barrel and `BACKENDS` / `labelFor` are far too generic to claim
 * there — consumers alias them back on import.
 */

import { Box, Cpu } from 'lucide-react';

export const LOCAL_LLM_BACKENDS = [
  { id: 'ollama', label: 'Ollama', icon: Cpu },
  { id: 'lmstudio', label: 'LM Studio', icon: Box }
];

export const localLlmBackendLabel = (id) => LOCAL_LLM_BACKENDS.find((b) => b.id === id)?.label || id;

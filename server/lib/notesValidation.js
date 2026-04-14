import { z } from 'zod';
import { isAbsolute } from 'path';

// Shared: safe relative path (no traversal, no absolute/drive/UNC forms).
// Rejects:
//   - any path segment equal to `..` or `.` (traversal) while still allowing
//     filenames like `notes..md` or `v1..v2.md`
//   - leading `/` (posix absolute)
//   - Windows drive letters (e.g. `C:\foo`) and UNC paths (e.g. `\\host\share`)
//   - backslashes anywhere (only forward slashes are valid separators)
//   - anything path.isAbsolute recognises on the current platform
const safeRelativePath = z.string().min(1).max(1000).refine(
  p => {
    if (p.startsWith('/')) return false;
    if (p.includes('\\')) return false; // blocks UNC and Windows separators
    if (/^[A-Za-z]:/.test(p)) return false; // blocks drive-letter prefixes
    if (isAbsolute(p)) return false;
    const segments = p.split('/');
    if (segments.some(seg => seg === '..' || seg === '.')) return false;
    return true;
  },
  { message: 'Path must be relative, forward-slash separated, and cannot contain .. segments' }
);

export const vaultInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000)
});

export const vaultUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000).optional()
});

export const notePathSchema = z.object({
  path: safeRelativePath
});

export const createNoteSchema = z.object({
  path: safeRelativePath,
  content: z.string().max(500000).optional().default('')
});

export const updateNoteSchema = z.object({
  content: z.string().max(500000)
});

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50)
});

export const scanQuerySchema = z.object({
  folder: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

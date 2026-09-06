/** Toolkit-local Pi identity and model table parser. */
import { commandBasename } from './commandBasename.js';
export const PI_COMMAND = 'pi';
export const isPiCommand = (command) => commandBasename(command) === PI_COMMAND;

/** Pi lists provider, model, context, max output, thinking, and image columns. */
export function parsePiModelList(stdout) {
  const ids = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length >= 4 && /^[\d.,]+[kKmM]?$/.test(columns[2])
      && /^[a-zA-Z0-9._-]+$/.test(columns[0]) && /^[a-zA-Z0-9._:/-]+$/.test(columns[1])) {
      ids.push(`${columns[0]}/${columns[1]}`);
    }
  }
  return [...new Set(ids)];
}

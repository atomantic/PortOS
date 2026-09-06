/** Pi CLI argv conventions. See https://pi.dev/docs/latest/usage. */
import { argvHasFlag, commandBasename, hasModelFlag, buildEffortArgs } from './providerModels.js';

export const PI_COMMAND = 'pi';
export const isPiCommand = (command) => commandBasename(command) === PI_COMMAND;

export function ensurePiTuiArgs(baseArgs = []) {
  const args = [...baseArgs];
  if (!argvHasFlag(args, ['--approve', '-a', '--no-approve', '-na'])) args.push('--approve');
  return args;
}

export function ensurePiHeadlessArgs(baseArgs = [], model, effort) {
  const args = ensurePiTuiArgs(baseArgs);
  if (!argvHasFlag(args, ['--print', '-p'])) args.push('--print');
  if (model && !hasModelFlag(args)) args.push('--model', model);
  args.push(...buildEffortArgs(effort, { command: PI_COMMAND }, args));
  return args;
}

export function preparePiPrompt(args = [], prompt = '') {
  // Prefix prevents pi interpreting a leading @ as a file attachment; -- ends
  // option parsing so a prompt cannot inject CLI flags.
  return { args: [...args, '--', `Task:\n${prompt}`], useStdin: false, cleanup: () => {} };
}

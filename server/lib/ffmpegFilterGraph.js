/**
 * Passing a long ffmpeg filter graph by file instead of on the command line.
 */
import { writeFile } from 'fs/promises';
import { promisify } from 'util';
import { execFile } from './childProcess.js';
import { safeChildProcessOptions } from './processEnv.js';

// Linux refuses any one argument over 128 KiB and Windows a whole command line
// over 32K characters, so a filter graph longer than this goes to ffmpeg in a file.
export const FILTER_GRAPH_ARG_LIMIT = 16 * 1024;

// ffmpeg 7 reads an option's value from a file with `-/filter_complex <file>`;
// older builds only have `-filter_complex_script`, which later builds drop.
// `null` = not probed; a probe that couldn't run stays uncached.
let filterGraphFileFlag = null;

const probeFilterGraphFileFlag = async (bin) => {
  if (filterGraphFileFlag) return filterGraphFileFlag;
  const out = await promisify(execFile)(bin, ['-hide_banner', '-version'], safeChildProcessOptions({}))
    .then((r) => String(r.stdout || ''), () => null);
  // A git build ("ffmpeg version N-…") is newer than any release.
  const major = /ffmpeg version n?(\d+)\./.exec(out || '')?.[1];
  const flag = major && Number(major) < 7 ? '-filter_complex_script' : '-/filter_complex';
  if (out !== null) filterGraphFileFlag = flag;
  return flag;
};

/**
 * `args` with a `-filter_complex` graph over `FILTER_GRAPH_ARG_LIMIT` written to
 * `path` and passed by file instead, as `{ args, file }` (`file` is null when the
 * graph stays inline). The caller removes `file` once ffmpeg has exited.
 */
export async function filterGraphViaFile(bin, args, path) {
  const at = args.indexOf('-filter_complex');
  if (at < 0 || Buffer.byteLength(args[at + 1]) <= FILTER_GRAPH_ARG_LIMIT) return { args, file: null };
  const flag = await probeFilterGraphFileFlag(bin);
  await writeFile(path, args[at + 1]);
  return { args: [...args.slice(0, at), flag, path, ...args.slice(at + 2)], file: path };
}

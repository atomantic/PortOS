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

const FFMPEG_7_RELEASE_DATE = '2024-04-05';

// ffmpeg 7 reads an option's value from a file with `-/<option> <file>`; older
// builds only have the `*_script` options, which later builds drop.
const FILE_FLAGS = {
  '-filter_complex': { current: '-/filter_complex', legacy: '-filter_complex_script' },
  '-vf': { current: '-/vf', legacy: '-filter_script:v' },
};
// `null` = not probed; a probe that couldn't run stays uncached.
let predatesFileOptionsCache = null;

const probePredatesFileOptions = async (bin) => {
  if (predatesFileOptionsCache !== null) return predatesFileOptionsCache;
  const out = await promisify(execFile)(bin, ['-hide_banner', '-version'], safeChildProcessOptions({}))
    .then((r) => String(r.stdout || ''), () => null);
  // An "N-…" git build is newer than any release, but a date-stamped one
  // ("ffmpeg version 2021-02-13-git-…", the common Windows builds) is only as
  // new as its date and `-/` landed with the 7.0 release.
  const major = /ffmpeg version n?(\d+)\./.exec(out || '')?.[1];
  const buildDate = /ffmpeg version (\d{4}-\d{2}-\d{2})-/.exec(out || '')?.[1];
  const predatesFileOptions = major ? Number(major) < 7 : Boolean(buildDate && buildDate < FFMPEG_7_RELEASE_DATE);
  if (out !== null) predatesFileOptionsCache = predatesFileOptions;
  return predatesFileOptions;
};

/**
 * `args` with a `-filter_complex` or `-vf` graph over `FILTER_GRAPH_ARG_LIMIT` written to
 * `path` and passed by file instead, as `{ args, file }` (`file` is null when the
 * graph stays inline). The caller removes `file` once ffmpeg has exited.
 */
export async function filterGraphViaFile(bin, args, path) {
  const option = Object.keys(FILE_FLAGS).find((name) => args.includes(name));
  const at = args.indexOf(option);
  if (at < 0 || Buffer.byteLength(args[at + 1]) <= FILTER_GRAPH_ARG_LIMIT) return { args, file: null };
  const flag = (await probePredatesFileOptions(bin)) ? FILE_FLAGS[option].legacy : FILE_FLAGS[option].current;
  await writeFile(path, args[at + 1]);
  return { args: [...args.slice(0, at), flag, path, ...args.slice(at + 2)], file: path };
}

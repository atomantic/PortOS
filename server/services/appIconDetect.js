import { existsSync } from 'fs';
import { readdir, realpath, stat } from 'fs/promises';
import { join, extname } from 'path';
import { isPathInsideDir, isTopLevelEntryName, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';

/**
 * Well-known icon paths to check, ordered by priority.
 * Paths are relative to the app's repoPath.
 */
const ICON_SEARCH_PATHS = [
  // Web app favicons/logos
  'public/favicon.svg',
  'public/apple-touch-icon.png',
  'public/favicon.png',
  'public/favicon.ico',
  'public/logo.svg',
  'public/logo.png',
  'public/icon.svg',
  'public/icon.png',
  'public/icon-512.png',
  'public/icon-192.png',
  'public/logo512.png',
  'public/logo192.png',
  'client/public/favicon.svg',
  'client/public/apple-touch-icon.png',
  'client/public/favicon.png',
  'client/public/favicon.ico',
  'client/public/logo.svg',
  'client/public/logo.png',
  'client/public/icon-512.png',
  'client/public/icon-192.png',
  'client/public/logo512.png',
  'client/public/logo192.png',
  'static/favicon.svg',
  'static/apple-touch-icon.png',
  'static/favicon.png',
  'static/favicon.ico',
  // Electron / desktop
  'build/icon.png',
  'resources/icon.png',
  'resources/icon.icns',
  // Root-level
  'icon.png',
  'icon.svg',
  'logo.png',
  'logo.svg',
];

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.icns': 'image/x-icns',
  '.webp': 'image/webp',
};

const ICON_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));

/**
 * Real path of a regular file that stays inside `repoPath` after symlinks are
 * resolved. A stored icon, an Xcode manifest, or a repo symlink can otherwise
 * name a host file and the icon route will return its bytes. `extensions`
 * limits the resolved target, so `favicon.svg -> .env` is not an icon.
 * @param {string} repoPath
 * @param {string} candidatePath
 * @param {Set<string>} extensions lowercase extensions including the dot
 * @returns {Promise<string|null>}
 */
async function resolveContainedFile(repoPath, candidatePath, extensions) {
  if (typeof repoPath !== 'string' || !repoPath || typeof candidatePath !== 'string' || !candidatePath) {
    return null;
  }
  if (!(extensions instanceof Set) || extensions.size === 0) return null;
  try {
    const root = await realpath(repoPath);
    const resolved = await realpath(candidatePath);
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    if (!extensions.has(extname(resolved).toLowerCase())) return null;
    if (!isPathInsideDir(root, resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** @param {string} repoPath @param {string} candidatePath @returns {Promise<string|null>} */
export function resolveContainedIcon(repoPath, candidatePath) {
  return resolveContainedFile(repoPath, candidatePath, ICON_EXTENSIONS);
}

async function isContainedDirectory(repoPath, candidatePath) {
  try {
    const root = await realpath(repoPath);
    const resolved = await realpath(candidatePath);
    const info = await stat(resolved);
    return info.isDirectory() && isPathInsideDir(root, resolved);
  } catch {
    return false;
  }
}

// SVGs that embed an external <image href="..."> won't render under the icon
// endpoint's strict `default-src 'none'` CSP, so they are unusable as app icons
// even though the file exists. Skip them and let detection fall through to a
// sibling PNG/raster file. Inline data: URIs are fine.
export async function isUsableSvg(filePath) {
  const content = await tryReadFile(filePath);
  if (content === null) return false;
  const externalImage = /<image\b[^>]*\b(?:xlink:)?href\s*=\s*['"](?!data:)/i;
  return !externalImage.test(content);
}

/**
 * Find the best Xcode AppIcon image from an asset catalog.
 * Looks for the largest available PNG in the appiconset.
 * @param {string} repoPath
 * @returns {Promise<string|null>} Relative path to the icon, or null
 */
async function findXcodeAppIcon(repoPath) {
  // Common locations for Assets.xcassets
  const assetDirs = [
    '', // root
  ];

  // First, find all .xcassets directories
  const entries = await readdir(repoPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      assetDirs.push(entry.name);
    }
  }

  for (const dir of assetDirs) {
    const base = dir ? join(repoPath, dir) : repoPath;

    // Check for Assets.xcassets/AppIcon.appiconset
    const appIconSetPaths = [
      join(base, 'Assets.xcassets', 'AppIcon.appiconset'),
      // Some projects nest assets inside a subfolder matching the app name
    ];

    // Also scan one level deeper for nested project structures
    if (dir) {
      const subEntries = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const sub of subEntries) {
        if (sub.isDirectory() && sub.name === 'Assets.xcassets') {
          appIconSetPaths.push(join(base, 'Assets.xcassets', 'AppIcon.appiconset'));
        }
        if (sub.isDirectory()) {
          appIconSetPaths.push(join(base, sub.name, 'Assets.xcassets', 'AppIcon.appiconset'));
        }
      }
    }

    for (const iconSetPath of appIconSetPaths) {
      if (!await isContainedDirectory(repoPath, iconSetPath)) continue;

      const bestFromManifest = await bestManifestIcon(repoPath, iconSetPath);
      if (bestFromManifest) return bestFromManifest;

      const fallback = await firstContainedPng(repoPath, iconSetPath);
      if (fallback) return fallback;
    }
  }

  return null;
}

/**
 * Largest contained icon named by Contents.json. A manifest that itself
 * resolves outside the repo is ignored: its filenames are attacker-controlled
 * even when they point back at local images. Non-array `images` is the same
 * as no manifest so the PNG filename fallback can still run.
 * @param {string} repoPath
 * @param {string} iconSetPath
 * @returns {Promise<string|null>}
 */
async function bestManifestIcon(repoPath, iconSetPath) {
  const manifestPath = await resolveContainedFile(
    repoPath,
    join(iconSetPath, 'Contents.json'),
    new Set(['.json'])
  );
  if (!manifestPath) return null;
  const contents = await tryReadFile(manifestPath);
  if (!contents) return null;
  const images = safeJSONParse(contents, {})?.images;
  if (!Array.isArray(images)) return null;

  let bestIcon = null;
  let bestSize = 0;
  for (const img of images) {
    // Basename only: `join` treats an absolute filename as the whole path,
    // and `../` walks out of the asset catalog.
    if (!isTopLevelEntryName(img?.filename)) continue;
    const resolved = await resolveContainedIcon(repoPath, join(iconSetPath, img.filename));
    if (!resolved) continue;
    const sizeMatch = typeof img.size === 'string' ? img.size.match(/(\d+)x(\d+)/) : null;
    const scale = parseFloat(img.scale) || 1;
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) * scale : 0;
    if (size > bestSize) {
      bestSize = size;
      bestIcon = resolved;
    }
  }
  return bestIcon;
}

/** Reverse-sorted contained PNG in the icon set, for a missing or unusable manifest. */
async function firstContainedPng(repoPath, iconSetPath) {
  const files = await readdir(iconSetPath).catch(() => []);
  const pngs = files.filter(f => f.endsWith('.png')).sort().reverse();
  for (const name of pngs) {
    if (!isTopLevelEntryName(name)) continue;
    const resolved = await resolveContainedIcon(repoPath, join(iconSetPath, name));
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Detect the app icon path for a given project directory.
 * Returns the absolute path to the icon file, or null if none found.
 * @param {string} repoPath - Absolute path to the app's repository
 * @param {string} [appType] - Optional app type hint (ios-native, xcode, etc.)
 * @returns {Promise<string|null>}
 */
export async function detectAppIcon(repoPath, appType) {
  if (!repoPath || !existsSync(repoPath)) return null;

  // For Xcode/iOS projects, check AppIcon.appiconset first
  if (['ios-native', 'macos-native', 'xcode', 'swift'].includes(appType)) {
    const xcodeIcon = await findXcodeAppIcon(repoPath);
    if (xcodeIcon) return xcodeIcon;
  }

  // Check well-known paths. Resolve symlinks before accepting the file so
  // `public/` or the icon itself cannot point at a file outside the repo.
  for (const relPath of ICON_SEARCH_PATHS) {
    const contained = await resolveContainedIcon(repoPath, join(repoPath, relPath));
    if (!contained) continue;
    if (extname(contained).toLowerCase() === '.svg' && !await isUsableSvg(contained)) continue;
    return contained;
  }

  // For any project type, also try Xcode icon detection as a fallback
  // (some monorepos might have an iOS subfolder)
  if (!['ios-native', 'macos-native', 'xcode', 'swift'].includes(appType)) {
    const xcodeIcon = await findXcodeAppIcon(repoPath);
    if (xcodeIcon) return xcodeIcon;
  }

  return null;
}

/**
 * Get the content type for an icon file based on its extension.
 * @param {string} filePath
 * @returns {string}
 */
export function getIconContentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

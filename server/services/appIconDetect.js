import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';
import { safeJSONParse } from '../lib/fileUtils.js';

/**
 * Well-known icon paths to check, ordered by priority.
 * Paths are relative to the app's repoPath.
 */
const ICON_SEARCH_PATHS = [
  // Web app favicons/logos
  'public/favicon.svg',
  'public/favicon.png',
  'public/favicon.ico',
  'public/logo.svg',
  'public/logo.png',
  'public/icon.svg',
  'public/icon.png',
  'public/logo192.png',
  'public/logo512.png',
  'client/public/favicon.svg',
  'client/public/favicon.png',
  'client/public/favicon.ico',
  'client/public/logo.svg',
  'client/public/logo.png',
  'client/public/logo192.png',
  'client/public/logo512.png',
  'static/favicon.svg',
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
      if (!existsSync(iconSetPath)) continue;

      // Read Contents.json to find actual icon filenames and sizes
      const contentsPath = join(iconSetPath, 'Contents.json');
      if (existsSync(contentsPath)) {
        const contents = await readFile(contentsPath, 'utf-8').catch(() => null);
        if (contents) {
          const parsed = safeJSONParse(contents, {})?.images || [];
          // Find the largest icon by parsing size (prefer 1024x1024, then smaller)
          let bestIcon = null;
          let bestSize = 0;

          for (const img of parsed) {
            if (!img.filename) continue;
            const filePath = join(iconSetPath, img.filename);
            if (!existsSync(filePath)) continue;

            // Parse size from the "size" field (e.g., "1024x1024")
            const sizeMatch = img.size?.match(/(\d+)x(\d+)/);
            const scale = parseFloat(img.scale) || 1;
            const size = sizeMatch ? parseInt(sizeMatch[1]) * scale : 0;

            if (size > bestSize) {
              bestSize = size;
              bestIcon = filePath;
            }
          }

          // If Contents.json didn't yield results, fall back to scanning files
          if (!bestIcon) {
            const files = await readdir(iconSetPath).catch(() => []);
            const pngs = files.filter(f => f.endsWith('.png')).sort().reverse();
            if (pngs.length > 0) {
              bestIcon = join(iconSetPath, pngs[0]);
            }
          }

          if (bestIcon) return bestIcon;
        }
      }

      // Fallback: just grab the largest PNG by filename
      const files = await readdir(iconSetPath).catch(() => []);
      const pngs = files.filter(f => f.endsWith('.png')).sort().reverse();
      if (pngs.length > 0) {
        return join(iconSetPath, pngs[0]);
      }
    }
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

  // Check well-known paths
  for (const relPath of ICON_SEARCH_PATHS) {
    const fullPath = join(repoPath, relPath);
    if (existsSync(fullPath)) return fullPath;
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

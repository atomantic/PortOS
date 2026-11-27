/**
 * Filenames shared by Xcode script provisioning and its request validator.
 */

export const XCODE_SCRIPT_NAME = Object.freeze({
  deploy: 'deploy.sh',
  screenshots: 'take_screenshots.sh',
  macScreenshots: 'take_screenshots_macos.sh',
});

export const XCODE_SCRIPT_NAMES = Object.freeze(Object.values(XCODE_SCRIPT_NAME));

export const NON_PM2_TYPES = new Set(['ios-native', 'macos-native', 'xcode', 'swift']);
export const usesPm2 = (type) => !NON_PM2_TYPES.has(type);
export const DESKTOP_TYPES = new Set(['desktop']);
export const isDesktopType = (type) => DESKTOP_TYPES.has(type);

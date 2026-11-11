/** Styling retained only for older Suno builds without semantic selection state. */
export const SUNO_LEGACY_CLASSES = {
  // Older Advanced option rows mark the chosen button with the standard variant.
  optionSelected: /hxc-btn-variant-standard/,
  // Older Download dialogs mark selected formats with this pair of color tokens.
  formatSelected: ['bg-foreground-primary', 'text-background-primary'],
};

/** Read the first recognized semantic state; explicit false outranks legacy styling. */
export async function readChosenState(locator) {
  const names = ['aria-pressed', 'aria-checked', 'aria-selected', 'data-state', 'data-selected'];
  const values = await Promise.all(names.map((name) => locator.getAttribute(name)));
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]?.trim().toLowerCase();
    if (names[index] === 'data-state') {
      if (['on', 'checked', 'active', 'selected'].includes(value)) return true;
      if (['off', 'unchecked', 'inactive', 'unselected'].includes(value)) return false;
    } else {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
  }
  return null;
}

/** Legacy class tests are isolated here so they can be retired together. */
export async function readLegacyChosenState(locator, kind) {
  const classes = await locator.getAttribute('class') || '';
  if (kind === 'option') return SUNO_LEGACY_CLASSES.optionSelected.test(classes);
  const tokens = classes.split(/\s+/);
  return SUNO_LEGACY_CLASSES.formatSelected.every((token) => tokens.includes(token));
}

/**
 * Old format toggles expose only the selected color pair. One positive legacy
 * marker makes that legacy set readable; no markers and no semantic states is
 * unreadable, rather than proof that every format is off after a restyle.
 */
export async function readFormatSelection(buttons) {
  const states = await Promise.all(buttons.map(async (button) => {
    const semantic = await readChosenState(button);
    return { semantic, legacy: semantic === null && await readLegacyChosenState(button, 'format') };
  }));
  const hasLegacySelection = states.some(({ legacy }) => legacy);
  if (!hasLegacySelection && states.some(({ semantic }) => semantic === null)) return null;
  return states.map(({ semantic, legacy }) => semantic ?? legacy);
}

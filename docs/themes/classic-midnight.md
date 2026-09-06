# Classic Midnight

## Intent

Classic Midnight preserves the existing PortOS UI: dark utilitarian panels, blue accent actions, compact navigation, and familiar rounded cards. It is the compatibility baseline for every theme change.

The palette, typography, radius scale, and density are frozen. What the theme does carry is **material**: a hairline top sheen on cards, a real cast shadow beneath them, an accent rule on the active nav item, and a page backdrop that falls from near-black at the top to black at the bottom under a faint accent haze. Both modes stay deliberately **effect-free** — no scanlines, no grain, no aurora — so the baseline remains the reference against which every other theme's atmosphere is judged (`useTheme.test.jsx` pins the default theme as the "no effects" case).

## Integration Rules

- Use existing PortOS utility colors and component structure.
- Keep rounded panels at the current radius scale unless the component has a product reason to differ.
- Use blue for primary actions and focus states.
- Use existing spacing density.
- Avoid theme-specific conditionals. If a component works only in Classic Midnight, the component is too tightly styled.

## Component Notes

- Panels: `bg-port-card border border-port-border rounded-lg`.
- Inset regions: `bg-port-bg border border-port-border rounded-lg`.
- Primary buttons: `bg-port-accent text-port-on-accent`.
- Secondary buttons: `bg-port-card border border-port-border text-port-text-muted`.
- Code blocks: `bg-port-bg border border-port-border font-mono`.

## Validation

Classic Midnight should look nearly identical to the pre-manifest interface. Any major difference here should be intentional and documented in the PR.

Check the three elevation levels specifically: page, card, and a `bg-port-bg` well inside a card must each read as a distinct depth. The card sheen and shadow are what carry that separation now — the fills themselves are only ~1.15:1 apart.

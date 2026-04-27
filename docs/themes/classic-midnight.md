# Classic Midnight

## Intent

Classic Midnight preserves the existing PortOS UI: dark utilitarian panels, blue accent actions, compact navigation, and familiar rounded cards. It is the compatibility baseline for every theme change.

## Integration Rules

- Use existing PortOS utility colors and component structure.
- Keep rounded panels at the current radius scale unless the component has a product reason to differ.
- Use blue for primary actions and focus states.
- Use existing spacing density.
- Avoid theme-specific conditionals. If a component works only in Classic Midnight, the component is too tightly styled.

## Component Notes

- Panels: `bg-port-card border border-port-border rounded-lg`.
- Inset regions: `bg-port-bg border border-port-border rounded-lg`.
- Primary buttons: `bg-port-accent text-white`.
- Secondary buttons: `bg-port-card border border-port-border text-gray-300`.
- Code blocks: `bg-port-bg border border-port-border font-mono`.

## Validation

Classic Midnight should look nearly identical to the pre-manifest interface. Any major difference here should be intentional and documented in the PR.

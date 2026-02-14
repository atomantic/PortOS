# Mobile Responsive Skill Template

## Routing
**Use when**: Task description contains keywords like "mobile", "responsive", "tablet", "breakpoint", "viewport", "touch", "swipe", "small screen", "media query", "mobile-friendly", "adaptive", "layout"
**Don't use when**: Task is about desktop-only features, backend changes, or general CSS styling unrelated to responsiveness

## Task-Specific Guidelines

You are making UI components responsive or fixing mobile layout issues.

### 1. Understand the Current State
- Check existing Tailwind breakpoint usage in the component and its parents
- Identify which elements need to reflow, resize, or hide on smaller screens
- Test the current layout at common breakpoints: 375px (mobile), 768px (tablet), 1024px (desktop)

### 2. Tailwind-First Approach
- Use Tailwind responsive prefixes: `sm:`, `md:`, `lg:`, `xl:`
- Mobile-first design: base styles are mobile, add complexity at larger breakpoints
- Use `flex` and `grid` for layout — avoid fixed widths
- Use `w-full`, `max-w-*`, and `min-w-0` to prevent overflow
- Use `truncate` or `line-clamp-*` for text that might overflow on mobile

### 3. Common Responsive Patterns
- **Navigation**: Collapse to hamburger menu or bottom nav on mobile
- **Tables**: Horizontal scroll wrapper (`overflow-x-auto`) or card layout on mobile
- **Side panels**: Stack vertically on mobile (`flex-col md:flex-row`)
- **Forms**: Full-width inputs on mobile, multi-column on desktop
- **Modals/Dialogs**: Full-screen on mobile, centered overlay on desktop

### 4. Touch Considerations
- Minimum touch target: 44x44px (use `min-h-[44px] min-w-[44px]`)
- Add appropriate spacing between interactive elements
- Ensure hover-only interactions have touch alternatives
- Use `touch-manipulation` for better touch responsiveness

### 5. Design Token Compliance
Use project design tokens:
- Backgrounds: `bg-port-bg`, `bg-port-card`
- Borders: `border-port-border`
- Colors: `text-port-accent`, `text-port-success`, `text-port-warning`, `text-port-error`

### 6. Commit Message Format
Use prefix: `style(scope): description` or `fix(scope): description` for layout bugs

## Example: Successful Mobile Responsive Task

**Task**: "Make the settings page responsive for mobile devices"

**What the agent did**:
1. Read `client/src/pages/Settings.jsx` — found fixed-width sidebar and content area
2. Changed layout from `flex-row` to `flex-col md:flex-row`
3. Made sidebar full-width on mobile with horizontal scroll for tabs
4. Converted settings grid from `grid-cols-3` to `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
5. Added `overflow-x-auto` to data tables
6. Ensured all touch targets met 44px minimum
7. Committed: `style(settings): make settings page responsive for mobile and tablet`

**Why it succeeded**: Mobile-first approach, used Tailwind utilities, maintained design tokens, considered touch targets.

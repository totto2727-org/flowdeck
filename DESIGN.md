# Workflow Console Experiment Design System

## 0. Research Log

- Embedded references: shortlisted Sentry, PostHog, and ClickHouse for a data-dense operational console; selected the neutral operational Layer A direction and Sentry Layer B because its warm dark surfaces, explicit status colors, compact labels, and tactile depth fit long-running workflow inspection.
- Topcoat constraints: the fixed Topcoat 0.5.0 runtime is server-rendered, routes are Rust functions, and future components must fit its `view!` markup, component, asset, and optional client-runtime model.
- Lazyweb and Imagen: skipped to honor the bounded local experiment and the repository no-overengineering rule; no workflow UI is being designed or implemented in this bootstrap.

## 1. Atmosphere & Identity

A calm operational command surface for tracing work without visual noise. The signature is warm purple-black depth with a single lime signal reserved for healthy or actively progressing state. Design dials are `DESIGN_VARIANCE=3`, `MOTION_INTENSITY=2`, and `VISUAL_DENSITY=8`.

## 2. Color

All future CSS color values must be declared here before use.

| Role | Token | Value | Usage |
|---|---|---|---|
| Canvas | `--color-canvas` | `#150f23` | App background |
| Surface | `--color-surface` | `#1f1633` | Primary panels |
| Surface elevated | `--color-surface-elevated` | `#2a2040` | Popovers and selected panels |
| Border | `--color-border` | `#362d59` | Dividers and outlines |
| Text primary | `--color-text-primary` | `#ffffff` | Primary text |
| Text secondary | `--color-text-secondary` | `#e5e7eb` | Supporting text |
| Text muted | `--color-text-muted` | `#a99db8` | Metadata |
| Accent | `--color-accent` | `#6a5fc1` | Links and focus |
| Accent hover | `--color-accent-hover` | `#8c7ee3` | Hover state |
| Healthy | `--color-status-healthy` | `#c2ef4e` | Healthy and running state |
| Warning | `--color-status-warning` | `#ffb287` | Delayed or attention state |
| Error | `--color-status-error` | `#fa7faa` | Failed state |
| Focus | `--color-focus` | `#ffb287` | Focus ring |

## 3. Typography

All future CSS type values must be declared here before use.

| Role | Token | Size | Weight | Line height | Tracking |
|---|---|---:|---:|---:|---:|
| Page title | `--type-title` | `1.875rem` | 600 | 1.2 | `-0.01em` |
| Section title | `--type-section` | `1.25rem` | 600 | 1.3 | `0` |
| Body | `--type-body` | `1rem` | 400 | 1.5 | `0` |
| Compact body | `--type-body-compact` | `0.875rem` | 400 | 1.45 | `0` |
| Label | `--type-label` | `0.75rem` | 600 | 1.4 | `0.04em` |
| Code | `--type-code` | `0.8125rem` | 400 | 1.5 | `0` |

- UI stack: `Rubik, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Mono stack: `Monaco, Menlo, "Ubuntu Mono", monospace`.
- Labels may use uppercase; body text must not.

## 4. Spacing & Layout

All future CSS spacing, radii, widths, and layout tokens must be declared here before use. Browser mechanics such as percentages, intrinsic sizing, and `clamp()` remain raw.

| Token | Value | Usage |
|---|---:|---|
| `--space-1` | `0.25rem` | Icon and label |
| `--space-2` | `0.5rem` | Inline groups |
| `--space-3` | `0.75rem` | Compact controls |
| `--space-4` | `1rem` | Default padding |
| `--space-6` | `1.5rem` | Panel padding |
| `--space-8` | `2rem` | Section separation |
| `--space-12` | `3rem` | Page separation |
| `--radius-control` | `0.375rem` | Inputs and compact controls |
| `--radius-panel` | `0.75rem` | Panels and cards |
| `--content-max` | `72rem` | Main content width |

- Future shell: one readable column at 375px, two-pane layout only when content supports it, and no primary horizontal scrolling.
- Dense regions own their scrolling; the document must not hide status or controls.

## 5. Components

No workflow components are authorized in this bootstrap. The initial page is semantic server-rendered HTML, not a reusable primitive. Future components must document structure, variants, default/hover/focus/active/disabled/loading/empty/error states, keyboard behavior, token usage, and scroll ownership here before implementation.

## 6. Motion & Interaction

| Token | Value | Usage |
|---|---|---|
| `--motion-micro` | `120ms` | Press and focus feedback |
| `--motion-standard` | `220ms` | Panel and state transition |
| `--ease-standard` | `cubic-bezier(0.16, 1, 0.3, 1)` | Standard easing |

- Motion communicates state or spatial relationship only; decorative motion is prohibited.
- Animate only `transform`, `opacity`, or `filter` and respect `prefers-reduced-motion`.
- Full keyboard operation and visible focus are required for every future interaction.

## 7. Depth & Surface

The strategy is mixed tonal shift plus restrained borders. `--color-canvas`, `--color-surface`, and `--color-surface-elevated` establish hierarchy; `--color-border` separates dense regions. Future elevated controls may add `--shadow-inset: inset 0 1px 3px rgb(0 0 0 / 10%)` and `--shadow-panel: 0 10px 15px -3px rgb(0 0 0 / 10%)`; no undeclared shadow is permitted.

## 8. Accessibility Constraints & Accepted Debt

- Target WCAG 2.2 AA: 4.5:1 body contrast, 3:1 large text and non-text controls, visible focus, semantic landmarks, keyboard reachability, reduced-motion support, and usable reflow at 200% zoom.
- Primary persona: an engineer monitoring many concurrent operations who needs dense status scanning without losing location or recovery context.
- Cognitive constraints: stable labels and locations, explicit state names, plain-language errors, and recovery actions adjacent to failures.
- Accepted debt: none. No interactive workflow surface exists yet; accessibility claims beyond the semantic bootstrap page remain unmade.

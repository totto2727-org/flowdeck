# Workflow Console Experiment Design System

## 0. Research Log

- Embedded references: shortlisted Sentry, PostHog, and ClickHouse for a data-dense operational console; selected the neutral operational Layer A direction and Sentry Layer B because its warm dark surfaces, explicit status colors, compact labels, and tactile depth fit long-running workflow inspection.
- Topcoat constraints: the Topcoat 0.5-compatible runtime is server-rendered, routes are Rust functions, and future components must fit its `view!`, component, Datastar, Tailwind, and asset model.
- Lazyweb and Imagen: skipped to honor the bounded local experiment and the repository no-overengineering rule; the Sentry reference already supplies the requested concrete direction.

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
| `--control-min` | `2.75rem` | Minimum keyboard and touch target |
| `--graph-min` | `42.5rem` | Topology canvas inside its scroll owner |
| `--table-min` | `56rem` | History table with trigger and input columns inside its scroll owner |
| `--border-width` | `0.0625rem` | Dense structural dividers |

- The document owns vertical scrolling. The topology and history wrappers alone own horizontal scrolling.
- The page uses one readable column at 375px and a workflow rail plus inspection region above 60rem. Primary content never scrolls horizontally.

## 5. Components

### Workflow card

- Structure: one button card per code-defined workflow, followed by that workflow's own server-rendered input form. Each workflow module owns its fields, defaults, validation, and initial-state conversion. Code-defined cron schedules remain read-only inside their owning workflow card.
- States: default, selected, card hover/focus/active, field focus, native invalid input, run-button disabled/loading, and request error.
- Accessibility: `aria-pressed` identifies the selected workflow, every input has explicit labels and bounds, and all controls retain a visible focus state and minimum target size.

### Run inspector

- Structure: status, trigger, initial input, route, elapsed summary, legend, accessible inline SVG driven only by immutable topology IDs, and a stable step-trace detail region below the graph.
- States: empty, loading, running, completed, failed, and request error. State words remain visible so color is never the only cue.
- Layout: the graph wrapper exclusively owns horizontal scrolling; selected run details remain outside that region.
- Workflow context: an idle inspector follows the workflow card selection, while selecting a history row switches the visible topology to that run's workflow without changing its retained trace.

### Graph trace selection

- Structure: every SVG node and edge is a real keyboard-focusable button target. Selection opens no overlay; it updates the adjacent detail region with node status, state, start/finish times, duration, output, and selected edge.
- States: unavailable, running, completed, failed, hover, focus, and selected. `aria-pressed` identifies the selected graph element, and the detail heading names the selected node or edge.
- Interaction reference: adapts the explicit selected-state and mounted-content contract from the beui.dev tabs pattern without importing a motion dependency. The existing micro-duration color transition is the only selection motion, and reduced-motion disables it.
- Cognitive accessibility: SSE patches preserve an explicit Datastar selection signal. Changing the selected run resets to that run's current or latest trace so details never silently describe another run.

### Run history

- Structure: table with one button per row for selection and columns for run ID, trigger, input, status, route, and elapsed time.
- States: empty row, running values, completed values, failed values, selected row, hover, and focus.
- Accessibility: table headings identify data; row buttons provide keyboard selection; `aria-current` identifies the inspected run.
- Layout: the table wrapper exclusively owns horizontal scrolling.

## 6. Motion & Interaction

| Token | Value | Usage |
|---|---|---|
| `--motion-micro` | `120ms` | Press and focus feedback |
| `--motion-standard` | `220ms` | Panel and state transition |
| `--ease-standard` | `cubic-bezier(0.16, 1, 0.3, 1)` | Standard easing |

- Motion communicates state or spatial relationship only; decorative motion is prohibited.
- Animate only `transform`, `opacity`, or `filter` and respect `prefers-reduced-motion`.
- Full keyboard operation and visible focus are required for every future interaction.
- Server-sent snapshot patches change status, history, and topology without moving controls. The status message uses `aria-live="polite"`; request errors use an alert.
- Workflow selection changes the visible workflow-owned form and idle topology. Starting or inspecting a run binds the inspector to the run's immutable `workflow_id`.
- Graph selection uses click, Enter, or Space and keeps the trace panel mounted. Selection feedback uses color plus `aria-pressed` and a visible detail heading.

## 7. Depth & Surface

The strategy is mixed tonal shift plus restrained borders. `--color-canvas`, `--color-surface`, and `--color-surface-elevated` establish hierarchy; `--color-border` separates dense regions. Future elevated controls may add `--shadow-inset: inset 0 1px 3px rgb(0 0 0 / 10%)` and `--shadow-panel: 0 10px 15px -3px rgb(0 0 0 / 10%)`; no undeclared shadow is permitted.

## 8. Accessibility Constraints & Accepted Debt

- Target WCAG 2.2 AA: 4.5:1 body contrast, 3:1 large text and non-text controls, visible focus, semantic landmarks, keyboard reachability, reduced-motion support, and usable reflow at 200% zoom.
- Primary persona: an engineer monitoring many concurrent operations who needs dense status scanning without losing location or recovery context.
- Cognitive constraints: stable labels and locations, explicit state names, plain-language errors, and recovery actions adjacent to failures.
- Accepted debt: none. Browser visual QA is intentionally owned by the parent task; this implementation phase proves the HTTP surface and automatic gates only.

# shadcn/ui source and customization

## Provenance

The dashboard copies only `button.tsx`, `card.tsx`, and `badge.tsx` from the adjacent Projektor application's `src/web/components/generated/` directory on 2026-10-17.
Projektor records these as shadcn CLI 4.21.1 `base-nova` / Base UI generated sources, audited against the public registry on 2026-10-10.
This project did not rerun the generator or independently verify an immutable registry snapshot.
The official source families are [Button](https://ui.shadcn.com/r/styles/base-nova/button.json), [Card](https://ui.shadcn.com/r/styles/base-nova/card.json), and [Badge](https://ui.shadcn.com/r/styles/base-nova/badge.json).
Their source is maintained locally under `src/workers/frontend/features/components/generated/` rather than imported from a runtime component service.

## Local differences

- The three generated components use the configured `@/lib/utils` application alias without changing generated JSX, variants, or Base UI behavior.
- The import uses the normal application utility connection; source components contain no upstream-application customization comments.
- `src/workers/frontend/features/lib/utils.ts` supplies `cn` through `clsx` and `tailwind-merge`.
- `src/workers/frontend/features/styles/app.css` is limited to Tailwind imports, shadcn theme tokens, and base configuration.
- Application components own layout, responsive behavior, focus states, and graph states through Tailwind utilities.
- The application does not copy Projektor's tenant features, branding, authentication, charts, compatibility wrappers, or preference storage.
- Graph rendering, keyboard selection, run controls, and event/state presentations are application code outside generated UI.

## Configuration and updates

`components.json` records the compatible `base-nova`, Base UI, Tailwind v4, React Server Components, and alias configuration.
It is a maintenance input, not evidence that the CLI was run in this repository.
Keep generated files separate from dashboard behavior when updating.
Compare the current public registry after the official configuration transformations, retain the documented utility connection, and validate Base UI button semantics, disabled controls, keyboard graph selection, responsive overflow, and both workflow versions through the real local application.
No deployment or remote service is required for the component layer.

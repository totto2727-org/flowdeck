# Frontend Design State

## Current Objective

Expose per-node execution traces from the local Topcoat workflow dashboard for performance inspection and debugging.

## Locked Decisions

- Topcoat 0.5.0 at commit `88859796d88fac504be1b8e40a70d6f0dbacaaaa` on Rust 1.95.
- Operational Sentry-inspired dark direction; design dials 3/2/8.
- The immutable six-node branch/converge topology is visualized from domain IDs; workflow authoring is excluded.
- The document owns vertical scroll; topology and history independently own horizontal scroll.
- Polling is 120ms while any run is active and 1000ms while idle, with stable selection across refreshes.
- Graph nodes and edges are keyboard-selectable; trace details remain in a stable region below the graph and survive polling for the selected run.

## Source Inputs

- `DESIGN.md`
- Official Topcoat README, router documentation, JSON responder source, and serving source at the pinned commit.

## Design Brief

The console makes in-memory workflow state quickly scannable while keeping failures and request recovery explicit. An engineer can select a node or traversed edge to inspect typed state, timing, output, and failure details without leaving the run.

## Inclusive Personas

- Workflow operator: scans dense state, uses keyboard navigation, and must not rely on color alone.
- Focus-sensitive engineer: needs stable locations, plain labels, and restrained motion.

## Adaptive Preferences

Support reduced motion, 200% zoom, increased text size, keyboard-only operation, and sufficient contrast in future UI work.

## Verification Matrix

- Implementation: Rust format, check, test, Clippy, build, JavaScript syntax, and real HTTP route checks.
- Visual UI: real-browser click and keyboard selection at narrow, mid, and desktop widths, followed by independent visual review.

## Design Debt Register

None accepted.

## Evidence Index

Evidence is captured by the parent task; this worker does not modify `.omo/evidence/`.

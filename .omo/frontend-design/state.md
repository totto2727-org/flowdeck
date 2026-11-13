# Frontend Design State

## Current Objective

Select and execute multiple code-defined workflows while preserving per-node trace inspection.

## Locked Decisions

- Topcoat 0.5-compatible crates.io releases on Rust 1.95.
- Operational Sentry-inspired dark direction; design dials 3/2/8.
- Each workflow directory owns its input defaults, topology IDs, and graph-flow builder; browser authoring remains excluded.
- The workflow rail exposes two keyboard-selectable definitions and switches the idle topology and shared run-form defaults without page navigation.
- The document owns vertical scroll; topology and history independently own horizontal scroll.
- Polling is 120ms while any run is active and 1000ms while idle, with stable selection across refreshes.
- Graph nodes and edges are keyboard-selectable; trace details remain in a stable region below the graph and survive polling for the selected run.

## Source Inputs

- `DESIGN.md`
- Official Topcoat README, router documentation, JSON responder source, and serving source at the pinned commit.

## Design Brief

The console makes multiple in-memory workflow definitions and their run state quickly scannable. An engineer can choose a workflow, submit its configured input defaults, then select a node or traversed edge to inspect typed state, timing, output, and failure details without leaving the run.

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

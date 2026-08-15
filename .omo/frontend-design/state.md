# Frontend Design State

## Current Objective

Bootstrap the local Topcoat application and lock the design contract without implementing workflow UI.

## Locked Decisions

- Topcoat 0.5.0 at commit `88859796d88fac504be1b8e40a70d6f0dbacaaaa` on Rust 1.95.
- Operational Sentry-inspired dark direction; design dials 3/2/8.
- No graph flow, workflow behavior, external service, or persistence in this phase.

## Source Inputs

- `DESIGN.md`
- Official Topcoat README, router documentation, JSON responder source, and serving source at the pinned commit.

## Design Brief

Future work should make concurrent workflow state quickly scannable while keeping failures and recovery paths explicit. The bootstrap page intentionally provides only runtime identity.

## Inclusive Personas

- Workflow operator: scans dense state, uses keyboard navigation, and must not rely on color alone.
- Focus-sensitive engineer: needs stable locations, plain labels, and restrained motion.

## Adaptive Preferences

Support reduced motion, 200% zoom, increased text size, keyboard-only operation, and sufficient contrast in future UI work.

## Verification Matrix

- Bootstrap: Rust format, check, test, Clippy, and HTTP route checks.
- Future visual UI: real-browser visual QA at narrow, mid, and desktop widths before design review.

## Design Debt Register

None accepted.

## Evidence Index

Existing RED evidence remains under `.omo/evidence/`; this bootstrap does not modify it.

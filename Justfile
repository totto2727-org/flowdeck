set shell := ["bash", "-euo", "pipefail", "-c"]

default: ci

fix: fix-format fix-lint

fix-format:
    cargo fmt --all

fix-lint:
    cargo clippy --fix --allow-dirty --allow-staged --all-targets --all-features -- -D warnings

check: check-format check-lint check-js

check-format:
    cargo fmt --all --check

check-lint:
    cargo clippy --all-targets --all-features -- -D warnings

check-js:
    node --check src/app.js
    node --check src/app_render.js
    node --check src/app_trace.js

build: build-cargo build-nix

build-cargo:
    cargo build --all-features

build-nix:
    nix build --no-link

test: test-rust test-js

test-rust:
    cargo test --all-features

test-js:
    node --test tests/*.mjs

run:
    topcoat asset bundle
    cargo run

ci: check build test

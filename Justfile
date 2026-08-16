set shell := ["bash", "-euo", "pipefail", "-c"]

default: ci

fix: fix-format fix-lint

fix-format:
    cargo fmt --all

fix-lint:
    cargo clippy --fix --allow-dirty --allow-staged --all-targets --all-features -- -D warnings

check: check-format check-lint

check-format:
    cargo fmt --all --check

check-lint:
    cargo clippy --all-targets --all-features -- -D warnings

prebuild:
    topcoat asset bundle

build: prebuild
    cargo build --all-features

test:
    cargo test --all-features

run: prebuild
    cargo run

ci: check build test

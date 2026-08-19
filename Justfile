set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

fix: fix-rustfmt fix-clippy

fix-rustfmt:
    cargo fmt --all

fix-clippy:
    cargo clippy --fix --allow-dirty --allow-staged --all-targets --all-features -- -D warnings

check: check-rustfmt check-clippy

check-rustfmt:
    cargo fmt --all --check

check-clippy:
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

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

fix: fix-rustfmt fix-clippy

fix-rustfmt:
    cargo fmt --all

fix-clippy:
    cargo clippy --fix --allow-dirty --allow-staged --workspace --all-targets --all-features -- -D warnings

check: check-rustfmt check-clippy

check-rustfmt:
    cargo fmt --all --check

check-clippy:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

prebuild:
    topcoat asset bundle

build: prebuild
    cargo build --workspace --all-features

test:
    cargo test --workspace --all-features

# Optional end-to-end provider test with a real binary, isolated HOME, and synthetic upstream.
test-jcode-provider:
    FLOWDECK_JCODE_TEST_BIN="${FLOWDECK_JCODE_TEST_BIN:-{{justfile_directory()}}/.tools/jcode/bin/jcode}" cargo test -p flowdeck --lib real_private_jcode_process_sends_the_actual_session_header -- --ignored --nocapture

install-jcode:
    if [[ ! -x .tools/jcode/bin/jcode ]]; then cargo install --git https://github.com/1jehuang/jcode --rev a63dbc4546895ecb4d1be1a285d98e6e13fb1b74 --locked --root .tools/jcode jcode; fi

example-jcode-translation: install-jcode
    JCODE_BIN="{{justfile_directory()}}/.tools/jcode/bin/jcode" cargo run -p graph-flow-jcode --example jcode_translation

run: prebuild
    cargo run

ci: check build test

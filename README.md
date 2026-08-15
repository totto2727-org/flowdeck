# Workflow Console Experiment

Local-only Topcoat 0.5.0 experiment pinned to upstream commit `88859796d88fac504be1b8e40a70d6f0dbacaaaa` and Rust 1.95.

## Local commands

```bash
cargo run
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/api/health
```

```bash
cargo fmt --all -- --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

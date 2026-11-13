#![allow(
    clippy::expect_used,
    reason = "A failed stylesheet build must stop the Cargo build with the upstream error."
)]
#![allow(
    missing_docs,
    reason = "Cargo build scripts do not expose a library API."
)]

fn main() {
    topcoat::tailwind::BuildConfig::new()
        .input("src/app.css")
        .render()
        .expect("Topcoat must render the Tailwind stylesheet");
}

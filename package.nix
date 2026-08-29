{
  lib,
  rustPlatform,
  stdenv,
  topcoat-cli,
}:

rustPlatform.buildRustPackage {
  pname = "flowdeck";
  version = "0.1.0";

  src = lib.cleanSource ./.;
  cargoLock = {
    lockFile = ./Cargo.lock;
    outputHashes."jcode-harness-api-0.1.0" =
      "sha256-nDz6RvxLvl8ctFB3/BGC2F3uEQw0DZ2ynEoiefcJ4RQ=";
  };

  postBuild = ''
    mkdir .cargo
    printf '[build]\ntarget = "%s"\n' ${stdenv.hostPlatform.rust.rustcTarget} > .cargo/config.toml
    ${topcoat-cli}/bin/topcoat asset bundle --release --out "$PWD/target/assets"
    rm .cargo/config.toml
    rmdir .cargo
  '';

  postInstall = ''
    cp -R target/assets "$out/assets"
  '';

  meta = {
    description = "A local workflow cockpit for running, scheduling, and tracing graph-based workflows with Topcoat";
    license = lib.licenses.mit;
    mainProgram = "flowdeck";
    platforms = lib.platforms.unix;
  };
}

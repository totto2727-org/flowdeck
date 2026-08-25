{
  lib,
  rustPlatform,
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
    ${topcoat-cli}/bin/topcoat asset bundle --release --out "$PWD/bundled-assets"
  '';

  postInstall = ''
    cp -R bundled-assets "$out/assets"
  '';

  meta = {
    description = "A local workflow cockpit for running, scheduling, and tracing graph-based workflows with Topcoat";
    license = lib.licenses.mit;
    mainProgram = "flowdeck";
    platforms = lib.platforms.unix;
  };
}

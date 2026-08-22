{
  lib,
  rustPlatform,
  topcoat-cli,
}:

rustPlatform.buildRustPackage {
  pname = "workflow-console-experiment";
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
    description = "A local-only experiment for a workflow console built with Topcoat";
    license = lib.licenses.mit;
    mainProgram = "workflow-console-experiment";
    platforms = lib.platforms.unix;
  };
}

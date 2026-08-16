{ lib, rustPlatform }:

rustPlatform.buildRustPackage {
  pname = "workflow-console-experiment";
  version = "0.1.0";

  src = lib.cleanSource ./.;
  cargoLock.lockFile = ./Cargo.lock;

  meta = {
    description = "A local-only experiment for a workflow console built with Topcoat";
    license = lib.licenses.mit;
    mainProgram = "workflow-console-experiment";
    platforms = lib.platforms.unix;
  };
}

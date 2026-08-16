{
  lib,
  rustPlatform,
  fetchCrate,
}:

rustPlatform.buildRustPackage rec {
  pname = "topcoat-cli";
  version = "0.5.0";

  src = fetchCrate {
    inherit pname version;
    hash = "sha256-Z/Z9KCIj6M36MvKOpC3b0S24MPpov2nQCdNCg1Fp98U=";
  };
  cargoHash = "sha256-9KeF31rlUp5EuirfvIN7Cs0KUuZFvirYyQWFB4Ud5CE=";
  doCheck = false;

  meta = {
    description = "Command-line tooling for the Topcoat web framework";
    homepage = "https://github.com/tokio-rs/topcoat";
    license = lib.licenses.mit;
    mainProgram = "topcoat";
    platforms = lib.platforms.unix;
  };
}

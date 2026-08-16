{
  description = "A local-only workflow console experiment";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;
      overlay = final: _previous: {
        workflow-console-experiment = final.callPackage ./package.nix { };
      };
      mkPkgs =
        system:
        import nixpkgs {
          inherit system;
          overlays = [ overlay ];
        };
    in
    {
      overlays.default = overlay;

      packages = forEachSystem (
        system:
        let
          pkgs = mkPkgs system;
        in
        rec {
          inherit (pkgs) workflow-console-experiment;
          default = workflow-console-experiment;
        }
      );

      devShells = forEachSystem (
        system:
        let
          pkgs = mkPkgs system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.just
              pkgs.nodejs_24
              pkgs.rustup
            ];
          };
        }
      );
    };
}

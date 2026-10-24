{
  description = "A flake to provision my environment";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";
    home-manager.url = "https://flakehub.com/f/nix-community/home-manager/0.1";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
      home-manager,
    }:
    let
      username = "sandbox";
      homedir = "/home/${username}";
      stateVersion = "25.11";
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];

      mkHomeConfiguration =
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
          monid = pkgs.callPackage ./packages/monid.nix {
            bun2nix = bun2nix.packages.${system}.default;
          };
          oo-cli = pkgs.callPackage ./packages/oo-cli.nix {
            bun2nix = bun2nix.packages.${system}.default;
          };
          docker-credential-gh = pkgs.writeShellScriptBin "docker-credential-gh" ''
            set -e

            cmd="$1"
            if [ "erase" = "$cmd" ]; then
              cat - >/dev/null
              exit 0
            fi
            if [ "store" = "$cmd" ]; then
              cat - >/dev/null
              exit 0
            fi
            if [ "get" != "$cmd" ]; then
              exit 1
            fi

            host="$(cat -)"
            host="''${host#https://}"
            host="''${host%/}"
            if [ "$host" != "ghcr.io" ] && [ "$host" != "docker.pkg.github.com" ]; then
              exit 1
            fi

            token="$(gh config get -h github.com oauth_token)"
            if [ -z "$token" ]; then
              exit 1
            fi

            printf '{"Username":"%s", "Secret":"%s"}\n' "$(gh config get -h github.com user)" "$token"
          '';
        in
        home-manager.lib.homeManagerConfiguration {
          inherit pkgs;

          modules = [
            ({
              home.stateVersion = stateVersion;
              home.username = username;
              home.homeDirectory = homedir;

              home.packages =
                (with pkgs; [
                  git
                  ripgrep
                  sd
                  fd
                  nixfmt
                  just
                ])
                ++ [
                  monid
                  oo-cli
                  docker-credential-gh
                ];

              programs = {
                direnv.enable = true;
                git.enable = true;
                gh = {
                  enable = true;
                  gitCredentialHelper.enable = true;
                };
                home-manager.enable = true;
                bash.enable = true;
              };

              home.sessionPath = [ "$HOME/.local/bin" ];
            })
          ];
        };
    in
    {
      homeConfigurations = nixpkgs.lib.genAttrs (map (s: "${username}-${s}") systems) (
        name: mkHomeConfiguration (nixpkgs.lib.removePrefix "${username}-" name)
      );
    };
}

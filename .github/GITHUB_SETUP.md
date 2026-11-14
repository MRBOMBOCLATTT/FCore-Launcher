# GitHub repository setup for FCore Launcher

## Suggested repository description

Minecraft launcher with isolated instances, mod management, compatibility checks and built-in diagnostics.

## Suggested topics

`minecraft` `minecraft-launcher` `electron` `fabric` `forge` `neoforge` `modrinth` `curseforge` `mod-manager` `javascript`

## Suggested About website

Leave empty unless you have a stable project website or documentation URL.

## Repository image

Upload `assets/fcore-banner.svg` to the repository and use it at the top of README.

For the repository social preview, use a 1280×640 PNG/JPG. A matching image is included as `assets/fcore-social-preview.png`.

## Important before calling the project open source

1. Commit the actual source tree to `main` (or another clearly documented default branch). At the time this kit was prepared, the public `main` branch only showed `.github` and a one-line README.
2. Add the included `LICENSE` file to the repository root. This kit uses GNU GPL v3.0 (`GPL-3.0-only`). Before applying it, make sure you own or have permission to license all project code you intend to cover. Third-party dependencies and assets keep their own licenses; review them separately.
3. Review all files before pushing. Do not commit `.env`, account tokens, `GH_TOKEN`, user data, `userData`, build output or private logs.
4. Keep `README.md` build instructions aligned with the actual `package.json` scripts.
5. Publish v1.7.5 only after its source and release assets are available in the repository. The GitHub release page showed v1.7.0 as the latest published release when this kit was prepared.

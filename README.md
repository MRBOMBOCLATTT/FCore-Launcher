<p align="center">
  <img src="assets/fcore-banner.svg" alt="FCore Launcher" width="100%">
</p>

<p align="center">
  <a href="https://github.com/MRBOMBOCLATTT/FCore-Launcher/releases"><img src="https://img.shields.io/github/v/release/MRBOMBOCLATTT/FCore-Launcher?label=latest%20release&color=474ED8" alt="Latest release"></a>
  <a href="https://github.com/MRBOMBOCLATTT/FCore-Launcher/stargazers"><img src="https://img.shields.io/github/stars/MRBOMBOCLATTT/FCore-Launcher?style=flat&color=474ED8" alt="GitHub stars"></a>
  <a href="https://github.com/MRBOMBOCLATTT/FCore-Launcher/issues"><img src="https://img.shields.io/github/issues/MRBOMBOCLATTT/FCore-Launcher?color=474ED8" alt="Open issues"></a>
  <a href="https://github.com/MRBOMBOCLATTT/FCore-Launcher/commits/main"><img src="https://img.shields.io/github/last-commit/MRBOMBOCLATTT/FCore-Launcher?color=474ED8" alt="Last commit"></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0-474ED8" alt="License: GPL-3.0">
</p>

<p align="center">
  <strong>A Minecraft launcher that keeps your builds, mods and settings in one place.</strong>
</p>

<p align="center">
  <a href="https://github.com/MRBOMBOCLATTT/FCore-Launcher/releases/latest">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#building-from-source">Build from source</a> ·
  <a href="README.ru.md">Русский</a>
</p>

---

![FCore Launcher home screen](assets/screenshots/home-en.jpg)

## What is FCore Launcher?

**FCore Launcher** is a desktop Minecraft launcher built with Electron. Instead of digging through `.minecraft` by hand, you create separate **builds**, each with its own mods, resource packs, shaders, worlds and settings. The launcher installs the right Java, checks your mods before launch and helps you maintain the game afterwards.

It supports **Vanilla, Fabric, Forge and NeoForge**, searches **Modrinth and CurseForge**, and is fully open source under GPL-3.0.

The interface is available in **English and Russian**.

## Screenshots

| Builds | Content |
| --- | --- |
| ![Builds](assets/screenshots/builds-en.jpg) | ![Mods](assets/screenshots/content-en.jpg) |

## Features

### Builds and launching

- A separate set of mods, resource packs, shaders, worlds and settings for every build.
- Vanilla, Fabric, Forge and NeoForge.
- Import and export builds as `.mrpack`.
- Move a build to another Minecraft version, with a search for matching mod versions.
- Compare two builds and copy selected mods between them.
- Game Presets and Server Presets for different launch scenarios.

### Mods and content

- Search and install mods, resource packs and shaders from Modrinth and CurseForge.
- Dependency management and a graph of how mods relate to each other.
- Pre-launch check: missing dependencies, wrong versions and likely conflicts.
- Duplicate detection by JAR contents, not just by file name.
- Mod Compatibility Watcher: finds compatible updates for your mods.
- Mod groups, favorite mods and resource-pack profiles.

### Diagnostics and maintenance

- Verify / Repair for build files.
- Log and crash analysis.
- Storage Analyzer: see what takes up disk space.
- Build Snapshots: save the state of a build and roll back to it.
- Download Manager with progress and operation history.
- Performance Monitor: CPU and RAM usage of the running game.
- Gaming Activity: play-time statistics and session history.

### Accounts and convenience

- Microsoft and Ely.by sign-in.
- Skin management with preview.
- Discord Rich Presence.
- Automatic Java installation and environment checks.
- Light and dark themes, English and Russian interface, custom fonts.
- Screenshot gallery and server list.

> The set of features depends on the launcher version. New features may appear in development builds before they reach a published release.

## Installation

### Requirements

- Windows 10 or 11 (64-bit).
- An internet connection for the first launch: the launcher downloads Minecraft, the mod loader and Java.
- A Minecraft account. Microsoft and Ely.by accounts are supported.
- You do **not** need to install Java yourself; FCore Launcher downloads the version that fits your Minecraft version.

### Steps

1. Open the [Releases page](https://github.com/MRBOMBOCLATTT/FCore-Launcher/releases/latest).
2. Under **Assets**, download the installer (the `.exe` file).
3. Run it and follow the installer.
4. Start **FCore Launcher** from the Start menu or the desktop shortcut.

> **Windows SmartScreen:** if Windows shows "Windows protected your PC", click **More info → Run anyway**. This message appears for many apps from independent developers. If you prefer, you can read the source here and [build the launcher yourself](#building-from-source).

## Getting started

1. **Sign in.** Click **Accounts** in the bottom-left corner and add a Microsoft or Ely.by account.
2. **Pick a version.** On the **Home** tab, choose a Minecraft version and a loader (Fabric, Forge, NeoForge or Vanilla).
3. **Create a build** (optional but recommended). Open **Builds → Create build**, give it a name and pick the version and loader. Every build keeps its own mods, worlds and settings, so experiments never break your main game.
4. **Add mods.** Open **Content**, search for a mod, press **Add**. Dependencies are installed together with the mod.
5. **Launch.** Press **Launch Minecraft**. The launcher checks the build and installs anything missing first.

Already have a modpack? Use **Import .mrpack**, **Import from a launcher** or **Import by code** on the Builds tab.

## FAQ

**Do I need to install Java?**
No. The launcher installs a suitable Java automatically.

**Where are my files stored?**
Everything lives in the game folder. Open it from **Home → Quick actions → Open the .minecraft folder**. Each build has its own subfolder, named after the build.

**Can I move my existing mods into a build?**
Yes. On the Builds tab, the default "No build" card has a **Move a version with mods into a build…** button.

**Are CurseForge mods supported?**
Yes, along with Modrinth. Availability of some CurseForge files depends on the authors' distribution settings.

**Does it work on macOS or Linux?**
Releases are currently provided for Windows. The code is Electron, so you can try running it from source on other systems, but this is not officially tested.

**Something went wrong. How do I report it?**
Open an [issue](https://github.com/MRBOMBOCLATTT/FCore-Launcher/issues) and include the launcher version, the Minecraft version, the loader, the steps to reproduce and the relevant part of the log. Never include tokens or passwords.

## Building from source

### Requirements

- Node.js and npm.
- Git.
- Windows for `build.bat` and preparing a Windows release.

### Run in development mode

```bash
git clone https://github.com/MRBOMBOCLATTT/FCore-Launcher.git
cd FCore-Launcher
npm install
npm start
```

### Build the app

```bash
npm run build
```

This uses `electron-builder` with the settings from `package.json`.

### Tests

```bash
npm test
```

Check translations:

```bash
npm install --no-save jsdom
npm run i18n:check
```

## Project structure

| Path | Purpose |
| --- | --- |
| `main.js`, `preload.js` | Electron main process and the safe API exposed to the UI |
| `src/` | Game launching, accounts, loaders, mods, storage and service logic |
| `renderer/` | Launcher UI, styles, icons and localization |
| `tests/` | Automated tests |
| `scripts/` | Maintenance and release scripts |
| `build/`, `resources/` | Assets and files for building the app |

## Contributing

Ideas, bug reports and pull requests are welcome.

Before opening an issue:

1. Check the [existing issues](https://github.com/MRBOMBOCLATTT/FCore-Launcher/issues).
2. Include the FCore Launcher version, Minecraft version and loader.
3. Add steps to reproduce and the relevant log excerpt. Do not attach tokens, passwords or other secrets.

For pull requests:

1. Create a separate branch from `main`.
2. Make one logically related change.
3. Run `npm test`.
4. Describe what changed and how to verify it.

## Security

- Never commit publishing tokens, passwords or account data.
- Release publishing uses the `GH_TOKEN` environment variable; secrets must not live in the source.
- External data (mod names, descriptions, game logs) must be sanitized before it is shown in the UI.
- If you find a vulnerability, do not publish a working exploit in a public issue. Contact the repository owner first.

## License

FCore Launcher is distributed under the **GNU General Public License v3.0 (GPL-3.0-only)**. The full text is in [`LICENSE`](LICENSE).

You may run the program, study its source, modify it and distribute the original and derived versions under the terms of GPL-3.0. When you distribute a derived version, you must keep the copyright and license notices and provide the corresponding source code under the same license.

Third-party libraries, assets and other components keep their own licenses. Check their terms before redistributing a build.

FCore Launcher is not an official Minecraft product and is not affiliated with Mojang or Microsoft.

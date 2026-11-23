# Building PageDotCom — one command, double-click installer

## What you get
Running `cargo tauri build` produces:
  src-tauri\target\release\bundle\nsis\PageDotCom_0.1.0_x64-setup.exe

This is a standard Windows installer. The user double-clicks it, clicks
Next a couple of times, and PageDotCom appears on their Desktop and Start
Menu. No Rust, Node, or anything else needed on the target machine.
WebView2 is bundled automatically (silently installs if not already present,
which covers all Windows 10/11 machines out of the box).

## One-time setup on YOUR dev machine (not the end user's)
```
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools"
winget install Rustlang.Rustup
rustup update stable
rustup target add x86_64-pc-windows-msvc
npm install -g @tauri-apps/cli
```

## Build the installer
```
cd pagedotcom
npm install
cargo tauri build
```
Installer will be at:
  src-tauri\target\release\bundle\nsis\PageDotCom_0.1.0_x64-setup.exe

## Cross-platform notes
Tauri must be built on the target OS — you can't cross-compile to Mac from Windows.
- Windows: produces .exe NSIS installer
- macOS:   produces .dmg (drag to Applications, no dependencies)
- Linux:   produces .deb / .AppImage

To build for all three you need CI (GitHub Actions is free and has all three runners).
A sample workflow is available at: https://tauri.app/distribute/github-actions/

## "Standalone" single file
Tauri apps require WebView2 (Windows) / WebKit (Mac/Linux) — these are OS components,
not something that can be bundled into a single .exe without a large (~150MB) overhead.
The NSIS installer is the closest practical equivalent: one file, double-click, done.

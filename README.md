# Cursor Usage Monitor

A lightweight VS Code extension that monitors your Cursor billing usage and shows it in the status bar.

## Features

- Status bar usage display with money or percentage.
- Manual refresh command.
- Configurable polling interval.

## Setup

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Press `F5` to launch the Extension Development Host.
4. Configure settings in VS Code:
   - `cursorUsage.displayMode` (`money` or `percent`)
   - `cursorUsage.refreshIntervalMinutes`
5. On first refresh, you'll be prompted for `WorkosCursorSessionToken` (stored in VS Code SecretStorage).

## Commands

- `Cursor Usage: Refresh`
- `Cursor Usage: Open Settings`
- `Cursor Usage: Update Token` (use the Command Palette when you need to update your token)

## Internal Distribution

1. Install deps: `npm install`
2. Build: `npm run build`
3. Package: `npm run package` (produces a `.vsix` file in the project root)
4. Install in VS Code:
   - UI: Extensions view -> `...` -> `Install from VSIX...`
   - CLI: `code --install-extension cursor-usage-0.0.1.vsix`

## Notes

- The extension calls `https://cursor.com/api/usage-summary` using your token.
- If the response structure changes, update the mapping logic in `src/extension.ts`.

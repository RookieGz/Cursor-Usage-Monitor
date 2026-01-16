<!--
 * @Date: 2026-01-15 15:41:54
 * @LastEditTime: 2026-01-15 17:00:57
 * @FilePath: /cursor-usage/README.md
 * @Description:
 *
-->

# Cursor Usage Monitor

A lightweight VS Code extension that monitors your Cursor billing usage and shows it in the status bar.

## Features

- Status bar usage display with percentage.
- Manual refresh command.
- Configurable polling interval and API settings.

## Setup

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Press `F5` to launch the Extension Development Host.
4. Configure settings in VS Code:
   - `cursorUsage.email`
   - `cursorUsage.teamId` (defaults to `14089613`)
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

- The extension calls `https://cursor.com/api/dashboard/get-team-spend` using your token and team ID.
- If the response structure changes, update the mapping logic in `src/extension.ts`.

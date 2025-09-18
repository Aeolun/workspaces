# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `@aeolun/workspaces`, a release-it plugin that automates the release and publishing process for workspace-based projects (npm, pnpm, yarn). The plugin extends release-it's functionality to handle multiple packages in a monorepo setup.

## Core Architecture

### Main Plugin Class
- **WorkspacesPlugin** (`index.js`): Extends release-it's `Plugin` class
- Key lifecycle methods: `init()`, `beforeBump()`, `bump()`, `release()`, `afterRelease()`
- Handles workspace discovery, version bumping, dependency updates, and npm publishing

### Key Components
- **Workspace Discovery**: Reads `package.json` workspaces config or `pnpm-workspace.yaml`
- **JSONFile Class**: Manages JSON file reading/writing with formatting preservation
- **Version Management**: Updates versions across packages and cross-dependencies
- **Publishing Pipeline**: Handles npm/pnpm publish with OTP, access control, and error handling

## Development Commands

```bash
# Run all checks and tests
npm test

# Code formatting and linting
npm run check
npm run check:fix

# Test commands
npm run test:vitest      # Run tests once
npm run test:watch       # Run tests in watch mode

# Release (for maintainers)
npm run release
```

## Testing

- **Framework**: Vitest (configured in `vitest.config.ts`)
- **Test Location**: `tests/**/*-test.js`
- **Test Helpers**: Uses `broccoli-test-helper`, `sinon`, `tmp` for testing

## Release Process

The project uses its own plugin for releases:
- Configured in `.release-it.json` with conventional changelog plugin
- Uses conventional commit messages for automatic version bumping:
  - `fix:` commits trigger **patch** versions (e.g., 1.0.0 → 1.0.1)
  - `feat:` commits trigger **minor** versions (e.g., 1.0.0 → 1.1.0)
  - `BREAKING CHANGE:` in commit body triggers **major** versions (e.g., 1.0.0 → 2.0.0)
- Git tags follow `v${version}` pattern
- GitHub releases are disabled (`"github": false`)
- Automated release via GitHub Actions on push to master

## Dependencies and Package Management

- **Peer Dependency**: `release-it` (versions 17-19 supported)
- **Key Dependencies**: 
  - `semver` for version parsing
  - `walk-sync` for workspace discovery
  - `yaml` for pnpm workspace config
  - `validate-peer-dependencies` for dependency validation

## Important Implementation Details

- Supports npm, pnpm, and yarn workspaces
- Preserves JSON formatting (indentation, line endings, trailing whitespace)
- Handles workspace protocol prefixes (`workspace:`) for pnpm
- Manages cross-package dependency version updates
- Supports custom dist-tags and registry configurations
- Includes OTP handling for 2FA publishing
- Handles private package filtering and scoped package access
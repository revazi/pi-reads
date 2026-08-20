# Release process

Pi Reads is currently distributed as a Git-based Pi package. Releases must preserve archive fidelity, keep local content and credentials out of the package, and remain installable without relying on this checkout.

## Prerequisites

- Node.js 24+
- pnpm 10.33.0
- Playwright Chromium (`pnpm article:install-browser`)
- a clean Git working tree
- GitHub CLI authentication for publishing a release

## Pre-release validation

From a fresh checkout:

```sh
pnpm install --frozen-lockfile
pnpm article:install-browser
pnpm release:check
```

`release:check` runs strict TypeScript checking, deterministic tests (including the extraction fixture, EPUB validation, and the real Astro/fidelity/PDF print pipeline), an Astro build, a package-content audit, a Pi extension-load smoke test, and a production dependency audit.

Also verify:

```sh
git status --short
npm pack --dry-run
```

The package must not contain `.agents`, tests, copied article bodies, raw source captures, credentials, PDFs, EPUBs, or other generated library artifacts.

## Current-repository release

Before the repository rename, the install check is:

```sh
pi install git:github.com/revazi/irakli-reads@v0.1.0
```

Create a signed or annotated tag only after CI passes for the exact release commit. Publish release notes from `CHANGELOG.md`. Do not tag from a dirty tree, retag a published version, or publish SMTP values while collecting diagnostics.

## Pi Reads rename release

The external rename requires explicit owner approval. Follow [the naming and compatibility procedure](naming-and-compatibility.md), update the local `origin`, verify GitHub's redirect, and rerun the complete release checks from a clean clone of `revazi/pi-reads`.

The stable install check will be:

```sh
pi install git:github.com/revazi/pi-reads@v1.0.0
```

Keep the `article:*` print workflow and its compatibility skill until a documented release explicitly removes them.

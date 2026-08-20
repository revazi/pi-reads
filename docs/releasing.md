# Release process

Pi Reads is distributed through npm, listed in the [Pi package gallery](https://pi.dev/packages/pi-reads), and available as a versioned Git-based Pi package. Releases must preserve archive fidelity, keep local content and credentials out of the package, and remain installable without relying on this checkout.

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

## Publishing a release

Stable install checks are:

```sh
pi install npm:pi-reads
pi install git:github.com/revazi/pi-reads@v1.1.0
```

The first npm publication establishes the package. Subsequent tagged releases use `.github/workflows/release.yml` with npm trusted publishing and provenance; no long-lived npm token belongs in GitHub secrets. The npm trusted publisher must match repository `revazi/pi-reads`, workflow `release.yml`, and environment `npm` exactly.

Create a signed or annotated tag only after CI passes for the exact release commit. The package version and changelog version must match the tag. Do not tag from a dirty tree, retag a published version, or publish SMTP values while collecting diagnostics.

The historical `v0.1.0` release was created before the GitHub rename. GitHub redirects its old URL to `revazi/pi-reads`; new documentation and installs must use the Pi Reads repository name.

Keep the `article:*` print workflow and its compatibility skill until a documented release explicitly removes them.

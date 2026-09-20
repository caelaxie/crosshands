# Install, update, and uninstall

CrossHands is a local computer-use runtime. It starts a broker and native
provider only in the current user's active graphical session. It does not expose
a network listener and cannot operate a remote machine in the first release.

## Before installing

- Use Node.js 22 or 24 on a supported OS and architecture.
- Install from the public npm registry unless a candidate evidence document
  names a different registry.
- Verify the release version, signed manifest digest, signer identity, SBOM,
  notices, and registry shown in the GitHub Release and release evidence.
  Never copy credentials into a package, command argument, or interactive
  runner.
- On macOS, use macOS 14 or later on Apple silicon or Intel. On Windows, use
  Windows 10 22H2 or a supported Windows 11 x64 build. On Linux, the full v1
  target is Ubuntu 24.04 x64 with GNOME on Xorg.

Pushing a signed `vVERSION` tag sets the product version on main and in the
packed packages. It creates a GitHub Release and publishes the package set to
npm. That path still requires the configured macOS Developer
ID/notarization and release-manifest signing credentials. Windows payloads are
unsigned. A source build or ad-hoc macOS signature is development evidence, not
a releasable package.

## Install

Install the CLI and MCP adapter together. The main package installs only the
compatible, exact-version platform payload through OS/CPU-constrained optional
dependencies.

```sh
npm install --global crosshands@VERSION @crosshands/mcp@VERSION
crosshands computer doctor --json
```

Replace `VERSION` with the GitHub Release tag without the leading `v`, or omit
it to take `latest`. Do not install `@crosshands/platform-*` directly. A missing
payload, wrong CPU, mixed version, changed payload, or unexpected signer is a
hard provider-integrity/readiness failure.

For a candidate, use only the candidate channel named in its evidence and
compare the registry-resolved package integrity with the signed manifest. The
default channel is not a substitute for candidate testing.

### Readiness

Run doctor from the same local desktop session in which the coding agent will
run:

```sh
crosshands computer doctor --json
```

Do not continue until doctor reports the following as ready or explicitly
explains a capability reduction:

- contract, control protocol, provider, and payload versions are compatible;
- the platform payload and native signature/hash match the release manifest;
- the broker endpoint is private to the current OS identity and graphical
  session;
- the session is local, active, and unlocked;
- required native dependencies and desktop services are available;
- Accessibility and screenshot permissions are reported separately; and
- requested capabilities are supported by the current desktop (for example,
  Linux Wayland intentionally lacks the X11 synthetic-input paths).

Permission grants remain manual. CrossHands never accepts a macOS TCC dialog,
bypasses Windows elevation/UAC, or enables Linux accessibility settings for the
operator.

## Update, downgrade, and rollback

Never update the CLI, MCP adapter, or platform payload independently. Install
the two public entry packages at the same exact version so the package manager
resolves a matching complete bundle:

```sh
npm install --global crosshands@NEW_VERSION @crosshands/mcp@NEW_VERSION
crosshands computer doctor --json
```

Close or drain active agent mutations before activation. The updater must stage
and verify the entire bundle, then switch activation atomically and restart the
broker. A restart invalidates interaction contexts; callers must observe again
and must not replay an uncertain mutation. If staging or activation is
interrupted, either the previous or replacement bundle must remain complete and
runnable.

Only the immediately previous release is a supported downgrade target. Install
both entry packages at that exact version and rerun doctor. Release rollback
moves the default tag for the main package first, then the matching payload and
adapter tags, using the recorded last-known-good digests. It deprecates a bad
version instead of unpublishing it. Promotion and rollback never rebuild an
artifact.

## Uninstall

1. Close Codex, OpenCode, OMP, and any other process connected to CrossHands.
2. Confirm no CrossHands broker or native helper remains active in the current
   session.
3. Remove the entry packages with the package manager that installed them:

   ```sh
   npm uninstall --global crosshands @crosshands/mcp
   ```

4. Remove only CrossHands-owned runtime state after confirming the path is not
   a symlink and is owned by the current user:
   - macOS: `~/Library/Caches/CrossHands/runtime/`
   - Windows: `%LOCALAPPDATA%\CrossHands\runtime\`
   - Linux: `$XDG_RUNTIME_DIR/crosshands/`

   Release packages may add CrossHands-owned cache, log, or temporary-capture
   directories. Their exact locations must be listed in that release's signed
   manifest and uninstall evidence before publication; remove only those listed
   locations.

5. Preserve user-owned exports and configuration. In particular, do not delete
   screenshots the user exported to another path.
6. Revoke OS permissions manually if desired:
   - macOS: remove **CrossHands Computer Use** from Privacy & Security >
     Accessibility and Screen & System Audio Recording.
   - Windows: CrossHands creates no automation-permission database entry. Review
     any administrator-created application-control allowlist entry and remove
     it only when its path matches the installed CrossHands helper.
   - Linux: no OS permission database entry is created; undo only accessibility
     settings the operator changed manually.

The uninstall verification is not complete until no CrossHands-owned process,
IPC endpoint, token, cache, log, or temporary capture remains and a clean
reinstall passes doctor. OS permission records are reported for manual cleanup;
they are never silently edited.

## Release lifecycle guarantees

Each candidate must pass clean install, use, upgrade, downgrade, rollback,
reinstall, broker-crash cleanup, connected-client handling, tamper rejection,
and uninstall/orphan-cleanup tests on its claimed OS/CPU matrix. The signed
manifest binds package versions and digests, native identities, SBOM, notices,
and signing evidence. Candidate packages are published to a non-default channel
payload-first and main-package-last. Promotion moves the exact tested digests to
the default channel; any digest, signature, notice, SBOM, version, or signer
mismatch stops the release.

Remote control, remote Windows sessions, hosted brokers, and remote-mode
security are deferred. The local release process must not imply those features
exist.

### Release workflow configuration

A signed `vVERSION` tag runs `Tag GitHub Release and npm`. That workflow sets
the product version on main and in the packed packages. It creates the GitHub
Release first, then publishes the assembled package set to
`https://registry.npmjs.org`. Dispatch it with `git_ref` to publish an existing
tag. `NPM_TOKEN` must be able to publish public packages on the `crosshands`
npm org.

The candidate/promote workflow expects protected `release-candidate` and
`release-production` environments with required reviewers. Before enabling it,
release owners must configure:

- `NPM_TOKEN` with publish rights on the public `crosshands` npm org;
- `NPM_REGISTRY_URL` for the candidate/promote restricted registry;
- `MACOS_DEVELOPER_ID_APPLICATION`, `MACOS_CERTIFICATE_BASE64`,
  `MACOS_CERTIFICATE_PASSWORD`, `MACOS_TEAM_ID`, `MACOS_NOTARY_APPLE_ID`, and
  `MACOS_NOTARY_APP_PASSWORD` for Developer ID signing and notarization;
- `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, and `COSIGN_PUBLIC_KEY` for the
  immutable registry-integrity evidence;
- `RELEASE_MANIFEST_PRIVATE_KEY_PEM` and `RELEASE_MANIFEST_PUBLIC_KEY_PEM` for
  the CrossHands signed release manifest consumed by installed-package
  verification; and
- `RELEASE_TAG_ALLOWED_SIGNERS` on the `release-candidate` environment, an
  SSH `allowed_signers` line whose principal is the tagger email. Candidate
  preflight verifies `vVERSION` with that file; GitHub's own "Verified" badge
  is not enough.

A candidate dispatch accepts only an exact signed `vVERSION` Git tag. Promotion
or rollback requires the original candidate workflow run ID and expected
release-manifest SHA-256. The production job downloads and verifies that
evidence, confirms the candidate registry integrities, and moves tags without a
checkout or build. Approvers must record signer fingerprints, notarization and
timestamp evidence, credential-expiry margin, SBOM and notice review,
last-known-good version, and the named release, platform, signing, benchmark,
rollback, and issue-intake owners.

If a promoted install fails in the field, dispatch `rollback` against the
last-known-good candidate digest.

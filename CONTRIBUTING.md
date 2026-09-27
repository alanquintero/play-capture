# Contributing

## Before opening a pull request

1. Run `npm test`.
2. Load the extension unpacked in Chrome 116 or newer and smoke-test the affected flow.
3. Check that `manifest.json` permissions remain minimal and justified in the README.
4. Update tests and documentation when behavior changes.
5. Do not commit recordings, browser profiles, IDE metadata, or generated build output.

## Pull request notes

Describe the user-visible behavior, the browser version used for manual testing, and any format or permission limitations. Keep changes focused; this project has no build step and no runtime npm dependencies.

## Scope and safety

Only record media you own or have permission to save. Contributions must preserve the local-only design and must not add DRM circumvention, credential collection, analytics, or remote upload behavior.

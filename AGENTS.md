# Project guidance

Play Capture is a Manifest V3 Chrome extension that locally captures the active tab's video and audio, waits for an HTML video to start, and stores finished recordings for download.

## Commands

- Test: `npm test`
- Browser smoke test: load this directory as an unpacked extension in Chrome 116+.

## Structure

- `background.js`: capture lifecycle, state, badges, downloads, and Chrome APIs.
- `content.js`: detects video play, pause, resume, end, and disappearance in every matching frame.
- `offscreen/`: owns `MediaRecorder`, audio playback routing, IndexedDB, and Blob downloads.
- `popup/`: user interface and recording library.
- `tests/`: Node-based content-script lifecycle tests.

Keep capture local-only and user-initiated. Do not add network upload, telemetry, DRM circumvention, or silent capture. Update the README and tests when permissions, supported formats, or lifecycle behavior changes.

## Working conventions

Run `npm test` after JavaScript changes. Browser-only behavior must also be smoke-tested in Chrome. Save temporary plans and agent-specific planning artifacts under `.agents/plans/`; that directory is intentionally gitignored.

## Further guidance

- [Contribution checklist](CONTRIBUTING.md) — read when preparing a change for review.

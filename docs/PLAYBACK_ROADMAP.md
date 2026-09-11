# Nuvi-Flow playback roadmap

This roadmap records the intended implementation order. Each milestone should
preserve direct playback, include focused regression tests, pass the complete
test/typecheck/build suite, and pass the gated Docker container health check
before its image is published.

## Completed foundations

- Secure, revocable addon installation URLs across all Stremio resources
- Signed direct-media and Silo proxy URLs
- Single-flight Silo session creation, active-session reuse, expiry, and
  structured playback IDs
- Application-wide Silo service boundary for runtime playback, media proxying,
  and admin connection tests
- Stable pseudonymous device identity carried in signed stream tokens, with
  explicit client identifiers preferred and non-invasive fallbacks
- Build version and Git revision visibility in the admin server-status card

## Current focus: persistent Silo file mapping

- Persist the Nuvi-Flow media file ID and resolved Silo file ID
- Store an optional Silo item ID, mapping status, mapped path, and update time
- Prefer deterministic path mapping and refresh it during scans
- Back up SQLite before applying the additive migration

## Next milestones

1. Conservative Auto playback policy with independent video, audio, HDR, and
   subtitle decisions
2. Streaming HLS proxy improvements, including URI attributes and nested
   playlists
3. Bounded automatic fallback using startup and throughput evidence
4. Capability learning with confidence, counters, and decay
5. Concurrency and transcoder-capacity controls

## Later interface work

- Reorganize the admin dashboard and settings into clearer task-oriented
  sections
- Keep system identity and health information together
- Improve responsive navigation without mixing UI restructuring into playback
  reliability patches

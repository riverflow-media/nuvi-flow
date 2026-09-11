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
- Persistent, server-scoped Silo file mappings with exact-path validation,
  scan-time invalidation, deletion cleanup, and a verified pre-migration SQLite
  backup

## Current focus: conservative Auto playback policy

- Derive protocol-v3 capability requests from source media and known device
  evidence rather than a fixed synthetic 1080p profile
- Preserve source resolution, including 4K, when the device and transcoder path
  can support it
- Adapt audio independently so incompatible TrueHD or DTS audio does not force
  an unnecessary video transcode
- Preserve HDR when support is known and tone-map only when necessary
- Keep unknown-device behavior conservative without automatically choosing the
  lowest resolution

## Next milestones

1. Streaming HLS proxy improvements, including URI attributes and nested
   playlists
2. Bounded automatic fallback using startup and throughput evidence
3. Capability learning with confidence, counters, and decay
4. Concurrency and transcoder-capacity controls

## Later interface work

- Reorganize the admin dashboard and settings into clearer task-oriented
  sections
- Keep system identity and health information together
- Improve responsive navigation without mixing UI restructuring into playback
  reliability patches

## Optional future features

- Optional per-user Silo statistics integration. Keep the default single-user
  setup unchanged; if enabled later, map distinct Nuvi-Flow playback users to
  Silo profiles and bridge playback progress/completion so Silo can attribute
  meaningful watch statistics per user.

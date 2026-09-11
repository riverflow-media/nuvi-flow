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
- Build version and Git revision visibility in the admin server-status card

## Current focus: stable device identity

- Derive a stable pseudonymous identity from explicit client identifiers when
  available
- Use signed installation/playback context as a safe fallback
- Do not rely on IP alone or use invasive browser fingerprinting
- Keep identity evidence separate from capability evidence

## Next milestones

1. Persistent Nuvi-Flow-to-Silo file mappings
2. Conservative Auto playback policy with independent video, audio, HDR, and
   subtitle decisions
3. Streaming HLS proxy improvements, including URI attributes and nested
   playlists
4. Bounded automatic fallback using startup and throughput evidence
5. Capability learning with confidence, counters, and decay
6. Concurrency and transcoder-capacity controls

## Later interface work

- Reorganize the admin dashboard and settings into clearer task-oriented
  sections
- Keep system identity and health information together
- Improve responsive navigation without mixing UI restructuring into playback
  reliability patches

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
- Persistent pseudonymous playback-device and capability-evidence tables with
  support state, provenance, confidence, success/failure counters, and timestamps
- User overrides protected from later automatic evidence writes; generic device
  profiles and raw fingerprinting inputs are never stored as capability facts
- Route-independent playback orchestration for capability lookup, policy planning,
  session keying/reuse, Silo start/replan validation, and structured summaries
- Capability snapshot revisions included in playback keys so changed evidence
  cannot reuse a session created under an older policy input

## Completed demand-aware pause/resume liveness foundation

- Treat actual proxied manifest and segment requests as local session activity
- Suppress upstream keepalives while real segment requests are active; once HLS
  traffic goes idle, send authenticated manifest checks at a bounded interval so
  Silo does not classify a short Nuvio pause as abandonment
- Limit the local idle lease to five minutes. Nuvi-Flow cannot distinguish pause
  from abandonment perfectly because the Stremio addon protocol supplies no
  pause, resume, or player-closed event
- Do not poll original/progressive streams; their live HTTP transport supplies
  its own liveness signal
- Keep the lease capped by the signed playback authorization and stop liveness
  checks after local expiry, preventing indefinite abandoned GPU work
- Preserve Silo's existing reconstruction and segment recovery behavior; no
  speculative retry loop or hidden replacement transcode is introduced

## Completed route-neutral Auto playback policy

- Protocol-v3 requests now use a route-neutral policy instead of a fixed,
  synthetic Android/1080p profile
- Auto keeps the source resolution class, including 4K, without treating a
  missing bandwidth estimate as zero or unlimited
- Auto negotiates original HTTP, progressive remux, HLS remux, and HLS
  transcode, allowing Silo to choose the least expensive compatible route
- Unknown devices conservatively declare MP4, H.264, AAC stereo, and SDR for
  original/progressive delivery; HLS remains the compatibility route
- Fixed quality rungs remain explicit HLS-only administrator overrides
- Progressive streams retain byte-range metadata and are not terminated by the
  media client's connection-start timeout
- The separate Direct Play stream can be hidden without disabling original
  playback inside Auto; it remains available whenever Silo is unavailable

Known HDR support is not inferred. HDR preservation will be enabled only after
capability evidence exists; until then Silo may tone-map incompatible HDR to
the declared SDR target.

## Completed streaming HLS proxy

- Stream media segments to clients immediately instead of buffering each full
  response in Nuvi-Flow
- Preserve upstream `200`, `206`, `304`, and `416` behavior plus content range,
  length, validator, and last-modified headers
- Rewrite nested playlists, query strings, absolute Silo URLs, and HLS `URI`
  attributes for keys, initialization maps, renditions, I-frame playlists, and
  low-latency hints
- Bound buffered manifest text and reject off-origin or out-of-session media
  references without exposing internal hostnames
- Keep credentials server-side and every child resource behind an expiring
  signed Nuvi-Flow URL

## Retired machine-specific Auto cost guard

- The early 1080p-medium guard reflected one mini PC's sustainable throughput
  and incorrectly limited more capable self-hosters
- Auto now preserves the source ceiling and lets Silo choose the highest
  compatible initial plan. Administrators can still select a fixed rung for a
  known constrained server

## Current focus and next milestones

1. Runtime fallback using measured manifest/segment response time, repeated slow
   segment counts, status failures, and startup latency. Silo does not currently
   expose encoder FPS/GPU utilization through protocol v3, so fallback must use
   observable proxy evidence and perform at most one quality replan
2. Capability learning rules with confidence thresholds and decay, followed by
   task-focused admin controls for explicit device overrides
3. Concurrency and transcoder-capacity controls

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

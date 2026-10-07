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
- Conservative positive capability learning from sustained direct and Silo
  delivery, requiring three distinct clean playbacks before a trait becomes
  trusted and applying a 90-day confidence half-life
- Authenticated, pseudonymous **Devices** controls with authoritative Supported,
  Unsupported, and Auto states for future playback planning
- Automatic evidence limited to unambiguous video codec, container, 4K, and
  plain HDR10 traits. Ambiguous failures, audio-track selection, Dolby Vision,
  and HDR10+ base-layer behavior do not create automatic support claims
- Format-specific protocol-v3 HDR declarations for HDR10, HDR10+, HLG, and
  explicit Dolby Vision profiles, preventing a single HDR override from
  overstating every dynamic-range format
- Audio passthrough remains disabled without Silo's required exact sink-layout
  evidence; ordinary codec decode/copy overrides do not imply bitstream support

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
- Auto offers the scanned source container and primary codecs to original HTTP
  first, even when the separate Direct entry is hidden. Progressive and HLS
  retain conservative H.264/AAC stereo compatibility targets so conversion is
  still available when needed
- Fixed quality rungs remain explicit HLS-only administrator overrides
- Progressive streams retain byte-range metadata and are not terminated by the
  media client's connection-start timeout
- The separate Direct Play stream can be hidden without disabling original
  playback or changing its priority inside Auto; it remains available whenever
  Silo is unavailable

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

### Completed optional fallback-addon foundation

- Disabled-by-default private Stremio-compatible provider settings and an
  authenticated manifest connection test, with AIOStreams detection
- Auto-only lookup before a device without explicit codec evidence would likely
  require full video conversion; H.264/direct and fixed-quality requests keep
  their existing behavior
- Five-second bounded lookups, single-flight request coalescing, short result
  caching, and active fallback-session reuse
- Up to ten safe candidates retained: the provider's first four choices plus
  smaller candidates across available resolution tiers, followed by remaining
  provider-ranked results. A bounded 15-second pre-response failover budget and
  sticky reuse prevent unbounded retries and unnecessary source changes
- A one-time startup throughput probe, when candidate or response size and local
  runtime are known: read at most 512 KiB for at most three seconds and require
  estimated average bitrate plus 35% headroom. Probe bytes are preserved for
  the client; candidates without usable size metadata retain availability-only
  failover
- Candidate acceptance limited to immediately playable public HTTPS progressive
  URLs; torrent-only, not-ready, HLS, credential-bearing, local, and private-IP
  URLs are rejected
- Candidate URLs and optional upstream request headers remain in a process-local
  registry. Clients receive only an expiring signed session token, and Range
  requests are streamed through Nuvi-Flow
- No mid-playback source replacement is claimed: the Stremio addon protocol does
  not provide a reliable player-position or stream-swap event

### Completed dynamic Auto routing foundation

- Missing local movies and episodes can return an immediate signed fallback
  stream while the existing Radarr/Sonarr acquisition remains queued
- AIOStreams extended metadata is validated and normalized into size, duration,
  bitrate, resolution, and provider-order fields for deterministic scoring
- Auto ranks the highest-resolution candidate that fits the current effective
  budget, while retaining smaller cross-resolution candidates for bounded retry
- Candidate count (up to 25), startup budget, resolution ceiling, downgrade
  behavior, safety headroom, observation lifetime, and cold-start policy are
  configurable from the admin dashboard
- Successful direct/fallback transfers build short-lived estimates per
  pseudonymous device and hashed network context. Three clean observations are
  required; pauses, seeks, short ranges, errors, and abandoned transfers do not
  become routing evidence
- Network observations remain separate from durable codec/device capabilities,
  preventing one slow connection from permanently downgrading a device
- The additive SQLite table uses the verified pre-migration backup path

### Completed adaptive playback operations

- Auto HLS transcodes use observable startup latency, consecutive slow segment
  header waits, and repeated upstream failures; no encoder FPS or GPU metric is
  invented when protocol v3 does not provide one
- Silo-advertised quality rungs determine each materially cheaper replan: a
  struggling 4K plan prefers a viable 1080p rung, while 1080p steps through
  cheaper server-provided rungs when they are available
- HLS media-sequence and segment-duration data provide an approximate source
  position so the replan resumes near the active segment
- Each replan is single-flight. Successful steps clear the prior slow/failure
  streak, failed replans stop, repeated rungs are excluded, and the configurable
  1–3 attempt cap prevents retry loops
- Existing signed tokens resolve to the replacement session path, keeping
  manifest refresh and subsequent segment requests behind Nuvi-Flow
- Thresholds, feature toggle, and attempt cap are configurable in the admin
  dashboard; fixed-quality requests, original HTTP, remux, and fallback-addon
  playback are unchanged
- A successful AIO selection retires the exact matching Silo session before the
  fallback response is returned. Replaced, expired, and shutdown sessions use
  the same authenticated cleanup path
- Pending starts and in-flight replans are generation-fenced, so a late Silo
  result is stopped rather than leaving an obsolete FFmpeg workload running
- Cleanup is idempotent and scoped by device, media file, profile, mode, and
  episode context; unrelated viewers and playback requests are never retired
- Activity exposes sanitized Silo-session, start-admission, queue, and AIO proxy
  counts so operators can distinguish a playback problem from queued control
  work without exposing server credentials or internal URLs
- Authenticated stop controls retire one exact Silo or AIO playback ID. Silo
  uses the normal server stop API, while AIO cancellation aborts active upstream
  proxy reads; expiry and shutdown use the same cleanup ownership

### Completed playback activity foundation

- Add an authenticated **Activity** section to the admin dashboard for live and
  briefly idle playback sessions
- Cover all current delivery paths: direct local files, Silo original HTTP,
  progressive remux, HLS remux, HLS transcode, and external AIO fallback
- Show the selected route, source and target media characteristics, bounded
  fallback state, AIO candidate attempt, pseudonymous device label, and short
  playback trace ID
- Derive Silo and AIO entries from their authoritative runtime registries, and
  track direct byte-range transfers with a short process-local lease
- Distinguish starting, streaming, and idle/paused activity using actual proxy
  transfers and recent media requests; do not claim player state events that
  Nuvio/Stremio does not provide
- Keep activity ephemeral and operationally scoped. Signed token IDs, raw device inputs,
  file paths, upstream URLs, internal Silo session IDs, and credentials never
  enter the admin response
- Poll only while the Activity view is open, while retaining a manual refresh
  control and responsive cards for smaller screens

### Completed concurrency and transcoder-capacity controls

- Coalesce duplicate playback requests before admission so every shared start
  consumes only one slot
- Bound distinct Silo file-resolution/start operations with a configurable
  concurrent limit, FIFO queue, maximum queue depth, and queue wait timeout
- Keep Silo authoritative for active per-user streams/transcodes and stream-node
  job capacity. Nuvi-Flow does not duplicate incomplete server-wide accounting
  or block Silo from selecting an available transcode node
- Normalize retryable protocol-v3 `capacity_unavailable` and
  `route_capacity_unavailable` terminal decisions without exposing upstream
  detail
- Let Auto try the enabled secure fallback addon once on capacity exhaustion,
  even when proactive pre-transcode lookup is disabled; otherwise return a
  controlled `503` with `Retry-After`
- Stop an unexpected Silo session attached to any unusable decision so capacity
  failover cannot leave an orphaned server workload

### Completed server-observed playback outcome foundation

- Persist a sanitized, authenticated Activity timeline for route selection,
  accepted delivery responses, degraded delivery, bounded quality fallback,
  capacity exhaustion, and unavailable source or plan outcomes
- Keep one row per playback/classification pair, at most 2,000 rows, and at most
  30 days of history so HLS segment traffic cannot grow the database without
  bound
- Record only enumerated providers, routes, failure domains, and short reason
  codes. File paths, upstream URLs, signed tokens, headers, raw client identity,
  credentials, and internal Silo session IDs have no persistence field
- Treat accepted HTTP delivery as a server observation, not proof of client
  decode or playback. Slow delivery remains explicitly ambiguous when Nuvi-Flow
  cannot distinguish network, source, Silo, or transcoder pressure
- Never convert these observations into automatic negative device capability
  evidence. Existing positive learning still requires a sustained clean HLS
  run, and administrator overrides remain authoritative
- Apply the additive SQLite schema through the verified pre-migration backup
  path and keep outcome diagnostics unable to interrupt media delivery

### Remaining capability-learning boundary

- Add decoder-specific negative evidence only if a future client integration
  supplies an explicit, authenticated playback result that distinguishes decode
  incompatibility from network, source, proxy, or transcoder failure
- Require repeated observations, confidence/decay, and a reversible state before
  any such signal can influence Auto; one ambiguous failure must never blacklist
  a capability

## Completed admin interface organization foundation

- Group the main dashboard navigation into Monitor, Media, Playback, and System
  tasks while keeping the server state, version, and Git revision together
- Divide the previously long Settings page into General, Requests, Playback,
  Fallback, and Security workspaces without changing setting names, defaults,
  API payloads, or runtime behavior
- Keep all workspaces inside one atomic form so switching sections preserves
  unsaved edits and one action saves the complete configuration
- Open the correct hidden workspace when browser validation finds an invalid
  control, avoiding an invisible or unfocusable form error
- Provide keyboard-operable tabs, explicit selected/current-page state, and
  horizontally scrollable navigation on narrow screens

## Completed system health diagnostics foundation

- Add an authenticated **System health** workspace covering SQLite integrity,
  configured media-root readability, scanner state, runtime-secret length,
  Silo/profile availability, optional fallback-addon compatibility, playback
  admission state, and recent outcome classifications
- Keep integration checks strictly on demand. Coalesce concurrent requests and
  cache the complete snapshot for one minute so opening the dashboard cannot
  recreate idle profile or manifest polling
- Preserve the lightweight public `/health` contract used by Docker. Optional
  Silo or fallback-addon outages are visible to administrators without making
  the Nuvi-Flow container itself fail its liveness check
- Return a fixed, sanitized contract with aggregate operation/outcome counts.
  Filesystem paths, integration URLs, credentials, tokens, internal session
  IDs, upstream error strings, and raw device identities have no response field
- Provide responsive status cards, explicit manual refresh, and a copyable JSON
  diagnostic bundle for support and deployment troubleshooting

## Completed resilient scan operations foundation

- Expose process-local scan phase, elapsed time, discovered/examined/changed
  counts, match/error totals, and determinate processing progress through an
  authenticated, path-free API
- Replace eager scheduling of every file with a bounded worker pool so a cancel
  request stops admitting new work while preserving the configured concurrency
- Make `ffprobe` child processes abortable and use the same cancellation path
  for administrator requests and graceful shutdown
- Preserve already completed file updates, but skip removal reconciliation for
  every partial scan so cancellation cannot delete catalog entries that were
  simply not reached
- Persist explicit completed, cancelled, failed, and interrupted terminal states
  with fixed safe messages. Convert abandoned `running` rows on startup rather
  than presenting stale work as active
- Poll live progress only while Scan Logs is open or work is active, with
  responsive counters, a progress indicator, start controls, and a CSRF-protected
  cancel action

## Completed database backup and recovery foundation

- Create consistent SQLite snapshots through the live backup API while normal
  requests remain available, then run `quick_check` before publishing each file
- Run automatic backups every 24 hours by default, retain a bounded seven
  Nuvi-Flow-managed recovery points, and make both controls configurable by
  environment without touching unrelated files in the data volume
- Add an authenticated **Backups** workspace with sanitized status, manual
  creation, storage totals, next-due visibility, and downloads protected by the
  existing admin session
- Keep filesystem paths and the database filename out of every admin response;
  expose only opaque backup IDs and fixed safe failure messages
- Surface missing, overdue, running, and failed backup state in System Health
  without changing the public Docker liveness contract
- Keep restoration deliberately offline and document the WAL-safe recovery
  sequence instead of attempting to replace an open database

## Playback-server expansion

The existing Silo path remains the production playback implementation while
Jellyfin and Plex are added behind the same application-owned boundary. Every
provider must preserve the universal Auto order: byte-for-byte direct play,
container-only remux, audio-only conversion, and video conversion last. Nuvi-Flow
will orchestrate and proxy; it will not duplicate a provider's FFmpeg pipeline.

### Completed provider control-plane foundation

- Add server-side-only Jellyfin API-key and Plex token settings, disabled by
  default and never returned to the browser or diagnostic bundle
- Add authenticated connection tests for Jellyfin server identity and playback
  users, plus Plex server identity and accessible libraries
- Add a dedicated **Settings → Servers** workspace with saved-secret state,
  Jellyfin playback-user selection, and an explicit Plex no-Plex-Pass baseline
- Add cached, on-demand System Health checks for both providers without changing
  the public Docker liveness contract
- Keep Plex compatibility limited to Direct Play, Direct Stream/remux, and free
  software transcoding. Hardware transcoding and premium tone mapping must never
  be required or advertised as available without evidence

### Completed provider-scoped exact media mapping

- Paginate authenticated Jellyfin Movie/Episode inventories and Plex movie/TV
  leaves, resolving each Nuvi-Flow file to an exact Jellyfin item/media-source
  pair or Plex rating-key/part pair
- Reject title-only, first-result, and ambiguous duplicate-path matches; preserve
  the Plex origin-relative part key only after the exact file path is unique
- Support validated, longest-prefix `local => provider` translations for
  containers whose media mounts differ, while defaulting to exact normalized
  paths
- Persist mappings by hashed provider/server identity with a 24-hour positive
  refresh policy, short negative retry, scan-time stale marking, deletion
  cascade, and the verified pre-migration SQLite backup path
- Add authenticated manual refresh controls and aggregate System Health status
  using only ready/pending/stale/not-found/ambiguous/error counts; local paths,
  provider URLs, credentials, and internal item identifiers stay out of mapping
  status and diagnostic responses

### Next: Jellyfin playback implementation

- Translate the existing device capability snapshot into a bounded Jellyfin
  device profile and request `PlaybackInfo` for the configured playback user
- Accept only server-selected Direct Play, Remux, Direct Stream, or Transcode
  decisions that remain inside the configured Jellyfin origin
- Proxy direct/progressive/HLS responses behind expiring Nuvi-Flow signatures,
  keep the API key server-side, rewrite nested HLS resources, and preserve Range,
  validator, and cancellation behavior already proven by the Silo proxy
- Track and stop exact Jellyfin playback/transcode sessions through the unified
  activity, expiry, fallback, and graceful-shutdown lifecycle

### Then: Plex playback implementation

- Use the authenticated PMS playback-decision endpoint with the same conservative
  capability snapshot and direct-first policy
- Accept Direct Play, Direct Stream/remux, and software-transcode results only;
  the integration must operate on a free Plex Media Server account with no Plex
  Pass dependency
- Proxy every selected media or HLS resource behind signed Nuvi-Flow URLs, never
  place `X-Plex-Token` in a client-visible URL, and restrict child resources to
  the configured PMS origin and exact playback session
- Add exact session cleanup, Activity visibility, outcome classifications, and
  bounded admission without pretending Nuvi-Flow owns Plex-wide capacity

### Finally: unified provider orchestration

- Add an administrator-selected provider order and health-aware fallback across
  Silo, Jellyfin, and Plex while retaining Nuvi-Flow direct playback as the
  cheapest always-available route
- Key reuse by provider, server identity, media mapping, capability revision,
  quality policy, device, and episode context so sessions can never cross
  incompatible backends
- Apply existing single-flight starts, signed proxies, activity, cancellation,
  outcome diagnostics, adaptive fallback limits, and shutdown cleanup to every
  provider before any provider is eligible for automatic failover
- Complete focused provider tests plus the full test/typecheck/build suite and
  gated Docker health check at every phase before publishing its image

## Optional future features

- Optional per-user Silo statistics integration. Keep the default single-user
  setup unchanged; if enabled later, map distinct Nuvi-Flow playback users to
  Silo profiles and bridge playback progress/completion so Silo can attribute
  meaningful watch statistics per user.

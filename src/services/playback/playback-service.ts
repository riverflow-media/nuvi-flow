import type { MediaFileRow, MediaItemRow } from '../../types.js';
import type { SiloService } from '../silo-service.js';
import type {
  SiloEpisodeReference,
  SiloPlaybackDecision,
  SiloPlaybackPlan
} from '../silo.js';
import type { DeviceCapabilityStore } from './device-capabilities.js';
import type {
  FallbackAddonService,
  FallbackPlaybackSession
} from './fallback-addon.js';
import {
  planSiloPlayback,
  type PlaybackPolicyPlan
} from './playback-policy.js';
import {
  type PlaybackSessionRegistry,
  type PlaybackSessionResult,
  type PlaybackSession,
  type PlaybackSessionRetirementReason,
  PlaybackSessionRetiredError
} from './playback-sessions.js';
import { selectRuntimeFallbackQuality } from './runtime-fallback.js';

interface PlaybackLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

interface PlaybackServiceOptions {
  keepAliveIntervalMs?: number;
  keepAliveIdleAfterMs?: number;
  now?: () => number;
  runtimeFallback?: {
    enabled: () => boolean;
    slowSegmentMs: () => number;
    slowSegmentCount: () => number;
    startupMs: () => number;
  };
}

export interface PlaybackOrchestrationInput {
  item: MediaItemRow;
  file: MediaFileRow;
  deviceId: string;
  deviceIdentitySource: string;
  profileId: string;
  configuredQuality: string;
  authorizationExpiresAt: number;
  episode?: SiloEpisodeReference;
  networkEstimateMbps?: number | null;
  networkContextId?: string;
}

export interface PlaybackOrchestrationResult {
  sessionResult: PlaybackSessionResult;
  policy: PlaybackPolicyPlan;
}

export class PlaybackOrchestrationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'PlaybackOrchestrationError';
  }
}

/**
 * Route-independent playback coordinator.
 *
 * This is the single boundary for capability lookup, policy planning, session
 * coalescing/reuse, Silo start/replan, plan validation, and playback summaries.
 * HTTP authorization, redirects, and proxy responses remain in the route.
 */
export class PlaybackService {
  private readonly keepAliveTimer: NodeJS.Timeout | null;
  private readonly keepAliveIdleAfterMs: number;
  private readonly now: () => number;
  private keepAliveRunning = false;
  private readonly terminationPromises = new Map<string, Promise<void>>();
  private readonly terminatedSessionIds = new Set<string>();
  private fallbackAddon: FallbackAddonService | null = null;
  private readonly runtimeFallback: PlaybackServiceOptions['runtimeFallback'];

  constructor(
    private readonly silo: SiloService,
    private readonly sessions: PlaybackSessionRegistry,
    private readonly capabilities: DeviceCapabilityStore,
    private readonly logger: PlaybackLogger,
    options: PlaybackServiceOptions = {}
  ) {
    this.keepAliveIdleAfterMs = options.keepAliveIdleAfterMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.runtimeFallback = options.runtimeFallback;
    this.sessions.setRetirementHandler((session, reason) =>
      this.terminateSiloSession(session.siloSessionId, session.playbackId, reason)
    );
    const intervalMs = options.keepAliveIntervalMs ?? 15_000;
    if (intervalMs > 0) {
      this.keepAliveTimer = setInterval(
        () => void this.keepAliveActiveSessions(),
        intervalMs
      );
      this.keepAliveTimer.unref();
    } else {
      this.keepAliveTimer = null;
    }
  }

  setFallbackAddon(service: FallbackAddonService): void {
    this.fallbackAddon = service;
  }

  async tryFallback(
    input: PlaybackOrchestrationInput
  ): Promise<FallbackPlaybackSession | null> {
    if (!this.fallbackAddon) return null;
    this.capabilities.touchDevice(input.deviceId, input.deviceIdentitySource);
    const capabilitySnapshot = this.capabilities.getSnapshot(input.deviceId);
    const policy = planSiloPlayback(
      input.file,
      input.configuredQuality,
      input.deviceId,
      capabilitySnapshot
    );
    if (
      policy.mode !== 'auto-silo' ||
      !this.fallbackAddon.shouldTryForLocal(
        input.file,
        policy.target.likelyVideoTranscode,
        input.networkEstimateMbps
      )
    ) {
      return null;
    }
    const fallback = await this.fallbackAddon.tryPlayback(input);
    if (!fallback) return null;

    await this.sessions.retireMatching({
      deviceId: input.deviceId,
      mediaFileId: input.file.id,
      profileId: input.profileId,
      mode: 'auto-silo',
      season: input.episode?.season,
      episode: input.episode?.episode
    }, 'fallback_selected');

    return fallback;
  }

  touchMediaPath(pathname: string): boolean {
    return this.sessions.touchUpstreamPath(pathname);
  }

  recordMediaResponse(
    pathname: string,
    durationMs: number,
    status: number
  ): void {
    const observation = this.sessions.recordUpstreamResponse(
      pathname,
      durationMs,
      status,
      {
        slowSegmentMs: this.runtimeFallback?.slowSegmentMs() ?? 2500,
        slowSegmentCount: this.runtimeFallback?.slowSegmentCount() ?? 3
      }
    );

    if (!observation) return;
    if (observation.summaryDue) {
      this.logger.warn({
        playback_id: observation.playbackId,
        silo_session_id: observation.siloSessionId,
        upstream_status: observation.status,
        upstream_response_ms: observation.durationMs,
        media_request_count: observation.requestCount,
        slow_media_response_count: observation.slowResponseCount
      }, 'Playback media delivery is repeatedly slow or unavailable');
    }
    if (this.runtimeFallback?.enabled() && observation.fallbackDue &&
      observation.fallbackReason) {
      const session = this.sessions.claimRuntimeFallback(
        observation.playbackKey,
        observation.fallbackReason
      );
      if (session) void this.performRuntimeFallback(session);
    }
  }

  recordManifest(entries: Array<{
    path: string;
    positionSeconds: number;
  }>): void {
    this.sessions.recordSegmentTimeline(entries);
  }

  resolveMediaPath(pathname: string): string {
    return this.sessions.resolveUpstreamPath(pathname);
  }

  mediaSourceStartSeconds(pathname: string): number {
    return this.sessions.sourceStartSeconds(pathname);
  }

  private usableHlsPlan(decision: SiloPlaybackDecision): SiloPlaybackPlan | null {
    const plan = decision.playback_plan;
    return decision.outcome === 'playable' &&
      plan?.delivery === 'server_transcode_hls' &&
      plan.stream.protocol === 'hls' &&
      plan.stream.url.startsWith('/playback/')
      ? plan
      : null;
  }

  private async performRuntimeFallback(session: PlaybackSession): Promise<void> {
    const context = session.runtimeFallback;
    if (!context || !session.siloSessionId) return;
    const previousSessionId = session.siloSessionId;
    const startedAt = this.now();

    try {
      const decision = await this.silo.replanPlaybackQuality(
        session.siloSessionId,
        context.profileId,
        context.playbackAttemptId,
        context.plan,
        context.targetQuality,
        context.requestProfile,
        session.lastPositionSeconds
      );
      const plan = this.usableHlsPlan(decision);
      if (!plan) throw new Error('Silo did not return a usable fallback plan.');
      const upstreamPath = '/api/v1' + plan.stream.url;
      const applied = this.sessions.completeRuntimeFallback(session.playbackKey, {
        plan,
        upstreamPath,
        delivery: plan.delivery,
        siloSessionId: decision.session_id
      });
      if (!applied) {
        await this.terminateSiloSession(
          decision.session_id || previousSessionId,
          session.playbackId,
          'superseded'
        );
        return;
      }
      if (decision.session_id && decision.session_id !== previousSessionId) {
        await this.terminateSiloSession(
          previousSessionId,
          session.playbackId,
          'replaced'
        );
      }
      this.logger.info({
        playback_id: session.playbackId,
        silo_session_id: decision.session_id || session.siloSessionId,
        fallback_attempt: 1,
        fallback_reason: context.reason,
        fallback_quality: context.targetQuality,
        position_seconds: Number(session.lastPositionSeconds.toFixed(2)),
        replan_ms: this.now() - startedAt
      }, 'Playback quality fallback activated');
    } catch (error) {
      this.sessions.completeRuntimeFallback(session.playbackKey, null);
      this.logger.warn({
        playback_id: session.playbackId,
        silo_session_id: session.siloSessionId,
        fallback_attempt: 1,
        fallback_reason: context.reason,
        fallback_quality: context.targetQuality,
        error
      }, 'Playback quality fallback failed');
    }
  }

  async keepAliveActiveSessions(): Promise<void> {
    if (this.keepAliveRunning) return;
    this.keepAliveRunning = true;

    try {
      const sessions = (await this.sessions.activeSnapshot()).filter(session =>
        ['server_remux_hls', 'server_transcode_hls'].includes(session.delivery) &&
        this.now() - session.lastAccess >= this.keepAliveIdleAfterMs
      );

      await Promise.all(sessions.map(async session => {
        try {
          const alive = await this.silo.keepPlaybackAlive(session.upstreamPath);
          if (!alive) {
            this.logger.warn({
              playback_id: session.playbackId,
              silo_session_id: session.siloSessionId,
              status: 'unavailable'
            }, 'Playback keepalive was not accepted');
          }
        } catch (error) {
          this.logger.warn({
            playback_id: session.playbackId,
            silo_session_id: session.siloSessionId,
            error
          }, 'Playback keepalive failed');
        }
      }));
    } finally {
      this.keepAliveRunning = false;
    }
  }

  async close(): Promise<void> {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    await this.sessions.close();
    await Promise.allSettled(this.terminationPromises.values());
  }

  async orchestrate(
    input: PlaybackOrchestrationInput
  ): Promise<PlaybackOrchestrationResult> {
    this.capabilities.touchDevice(
      input.deviceId,
      input.deviceIdentitySource
    );
    const capabilitySnapshot = this.capabilities.getSnapshot(input.deviceId);
    const policy = planSiloPlayback(
      input.file,
      input.configuredQuality,
      input.deviceId,
      capabilitySnapshot
    );

    const sessionResult = await this.sessions.getOrCreate(
      {
        deviceId: input.deviceId,
        mediaFileId: input.file.id,
        profileId: input.profileId,
        mode: policy.mode,
        quality: policy.requestProfile.qualityPreference,
        audioSelection: 'policy-profile',
        subtitleSelection: 'none',
        dynamicRangeMode: policy.target.dynamicRange,
        capabilityRevision: capabilitySnapshot.revision,
        season: input.episode?.season,
        episode: input.episode?.episode
      },
      input.authorizationExpiresAt,
      async ({ playbackId }) => {
        const startupStartedAt = this.now();
        const started = await this.silo.startPlaybackForMedia(
          input.item,
          input.file,
          input.profileId,
          policy.requestProfile,
          input.episode
        );

        if (!started) {
          throw new PlaybackOrchestrationError(
            404,
            'This file could not be resolved in Silo.'
          );
        }

        const { fileId } = started;
        let { decision } = started;
        let plan = decision.playback_plan;
        const hlsPlan =
          ['server_remux_hls', 'server_transcode_hls'].includes(
            plan?.delivery || ''
          ) &&
          plan?.stream.protocol === 'hls' &&
          plan.stream.url.startsWith('/playback/');
        const progressivePlan =
          ['original_http', 'server_remux_progressive'].includes(
            plan?.delivery || ''
          ) &&
          plan?.stream.protocol === 'http_progressive' &&
          plan.stream.url.startsWith('/stream/');

        if (
          decision.outcome !== 'playable' ||
          !plan ||
          (!hlsPlan && !progressivePlan)
        ) {
          throw new PlaybackOrchestrationError(
            502,
            'Silo did not return a usable playback stream.'
          );
        }

        this.logger.info({
          playback_id: playbackId,
          device_id: input.deviceId,
          device_identity_source: input.deviceIdentitySource,
          capability_revision: capabilitySnapshot.revision,
          capability_evidence_count: capabilitySnapshot.capabilities.length,
          media_file_id: input.file.id,
          silo_file_id: fileId,
          silo_session_id: decision.session_id || null,
          source: {
            width: input.file.width,
            height: input.file.height,
            video_codec: input.file.video_codec,
            audio_codec: input.file.audio_codec
          },
          decision: plan.delivery,
          target: {
            quality: policy.requestProfile.qualityPreference,
            max_resolution: policy.target.maxResolution,
            width: plan.effective_recipe?.width || null,
            height: plan.effective_recipe?.height || null,
            video_codec: plan.effective_recipe?.video_codec || policy.target.videoCodec,
            audio_codec: plan.effective_recipe?.audio_codec || policy.target.audioCodec,
            dynamic_range: plan.effective_recipe?.dynamic_range || policy.target.dynamicRange
          },
          reason: plan.decision_reason || policy.reason,
          transformations: plan.transformations
            ?.map(transformation => transformation.name)
            .filter(Boolean) || [],
          startup_ms: this.now() - startupStartedAt,
          fallback_attempt: 0
        }, 'Playback session created');

        const targetQuality = policy.mode === 'auto-silo' &&
          plan.delivery === 'server_transcode_hls' &&
          decision.session_id && this.runtimeFallback?.enabled()
          ? selectRuntimeFallbackQuality(plan)
          : null;
        let fallbackState: 'ready' | 'completed' | 'failed' = 'ready';
        if (targetQuality && this.now() - startupStartedAt >=
          (this.runtimeFallback?.startupMs() ?? Number.POSITIVE_INFINITY)) {
          try {
            const previousSessionId = decision.session_id!;
            const replanned = await this.silo.replanPlaybackQuality(
              decision.session_id!,
              input.profileId,
              started.playbackAttemptId,
              plan,
              targetQuality,
              policy.requestProfile,
              plan.timeline?.source_start_seconds || 0
            );
            const fallbackPlan = this.usableHlsPlan(replanned);
            if (!fallbackPlan) throw new Error('Silo did not return a usable fallback plan.');
            decision = replanned;
            plan = fallbackPlan;
            fallbackState = 'completed';
            if (decision.session_id && decision.session_id !== previousSessionId) {
              await this.terminateSiloSession(
                previousSessionId,
                playbackId,
                'replaced'
              );
            }
            this.logger.info({
              playback_id: playbackId,
              silo_session_id: decision.session_id || null,
              fallback_attempt: 1,
              fallback_reason: 'startup_latency',
              fallback_quality: targetQuality
            }, 'Playback quality fallback activated');
          } catch (error) {
            fallbackState = 'failed';
            this.logger.warn({
              playback_id: playbackId,
              silo_session_id: decision.session_id || null,
              fallback_attempt: 1,
              fallback_reason: 'startup_latency',
              fallback_quality: targetQuality,
              error
            }, 'Playback quality fallback failed');
          }
        }

        return {
          siloSessionId: decision.session_id || null,
          siloFileId: fileId,
          upstreamPath: '/api/v1' + plan.stream.url,
          delivery: plan.delivery,
          planSummary: {
            width: plan.effective_recipe?.width || null,
            height: plan.effective_recipe?.height || null,
            videoCodec: plan.effective_recipe?.video_codec || null,
            audioCodec: plan.effective_recipe?.audio_codec || null,
            dynamicRange: plan.effective_recipe?.dynamic_range || null
          },
          runtimeFallback: targetQuality ? {
            profileId: input.profileId,
            playbackAttemptId: started.playbackAttemptId,
            plan,
            requestProfile: policy.requestProfile,
            targetQuality,
            state: fallbackState,
            reason: fallbackState === 'ready' ? null : 'startup_latency'
          } : undefined
        };
      }
    ).catch(error => {
      if (error instanceof PlaybackSessionRetiredError) {
        throw new PlaybackOrchestrationError(
          409,
          'A newer automatic playback route replaced this request.'
        );
      }
      throw error;
    });

    return { sessionResult, policy };
  }

  private terminateSiloSession(
    sessionId: string | null,
    playbackId: string,
    reason: PlaybackSessionRetirementReason | 'replaced'
  ): Promise<void> {
    if (!sessionId || this.terminatedSessionIds.has(sessionId)) {
      return Promise.resolve();
    }
    const existing = this.terminationPromises.get(sessionId);
    if (existing) return existing;

    const termination = (async () => {
      try {
        const stopped = await this.silo.stopPlayback(sessionId);
        this.terminatedSessionIds.add(sessionId);
        if (this.terminatedSessionIds.size > 1000) {
          const oldest = this.terminatedSessionIds.values().next().value;
          if (oldest) this.terminatedSessionIds.delete(oldest);
        }
        this.logger.info({
          playback_id: playbackId,
          silo_session_id: sessionId,
          retirement_reason: reason,
          upstream_status: stopped ? 'stopped' : 'already_gone'
        }, 'Playback session retired');
      } catch (error) {
        this.logger.warn({
          playback_id: playbackId,
          silo_session_id: sessionId,
          retirement_reason: reason,
          error
        }, 'Playback session retirement failed');
      } finally {
        this.terminationPromises.delete(sessionId);
      }
    })();
    this.terminationPromises.set(sessionId, termination);
    return termination;
  }
}

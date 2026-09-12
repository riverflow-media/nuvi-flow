import type { MediaFileRow, MediaItemRow } from '../../types.js';
import type { SiloService } from '../silo-service.js';
import type { SiloEpisodeReference } from '../silo.js';
import type { DeviceCapabilityStore } from './device-capabilities.js';
import {
  planSiloPlayback,
  selectAutoTranscodeFallback,
  type PlaybackPolicyPlan
} from './playback-policy.js';
import {
  type PlaybackSessionRegistry,
  type PlaybackSessionResult
} from './playback-sessions.js';

interface PlaybackLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

interface PlaybackServiceOptions {
  keepAliveIntervalMs?: number;
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
  private keepAliveRunning = false;

  constructor(
    private readonly silo: SiloService,
    private readonly sessions: PlaybackSessionRegistry,
    private readonly capabilities: DeviceCapabilityStore,
    private readonly logger: PlaybackLogger,
    options: PlaybackServiceOptions = {}
  ) {
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

  touchMediaPath(pathname: string): boolean {
    return this.sessions.touchUpstreamPath(pathname);
  }

  async keepAliveActiveSessions(): Promise<void> {
    if (this.keepAliveRunning) return;
    this.keepAliveRunning = true;

    try {
      await Promise.all(this.sessions.activeSnapshot().map(async session => {
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

  close(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
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
        const startupStartedAt = Date.now();
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

        const { fileId, playbackAttemptId } = started;
        let { decision } = started;
        const initialPlan = decision.playback_plan;
        const fallbackQuality = initialPlan
          ? selectAutoTranscodeFallback(input.configuredQuality, initialPlan)
          : null;

        if (
          fallbackQuality &&
          decision.session_id &&
          initialPlan?.plan_id &&
          initialPlan.plan_attempt_key
        ) {
          const replanned = await this.silo.replanPlaybackQuality(
            decision.session_id,
            input.profileId,
            playbackAttemptId,
            initialPlan,
            fallbackQuality,
            policy.requestProfile,
            initialPlan.timeline?.source_start_seconds || 0
          );

          if (replanned.outcome !== 'playable' || !replanned.playback_plan) {
            throw new PlaybackOrchestrationError(
              502,
              'Silo could not create the safer Auto playback route.'
            );
          }

          this.logger.info({
            playback_id: playbackId,
            silo_session_id: decision.session_id,
            from_quality: 'auto',
            to_quality: fallbackQuality,
            reason: 'full_4k_video_transcode_guard'
          }, 'Playback quality replanned');
          decision = replanned;
        }

        const plan = decision.playback_plan;

        if (
          decision.outcome !== 'playable' ||
          !plan ||
          !['server_remux_hls', 'server_transcode_hls'].includes(plan.delivery) ||
          plan.stream.protocol !== 'hls' ||
          !plan.stream.url.startsWith('/playback/')
        ) {
          throw new PlaybackOrchestrationError(
            502,
            'Silo did not return a usable transcoded HLS stream.'
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
            quality: fallbackQuality || policy.requestProfile.qualityPreference,
            max_resolution: fallbackQuality ? '1080p' : policy.target.maxResolution,
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
          startup_ms: Date.now() - startupStartedAt,
          fallback_attempt: fallbackQuality ? 1 : 0
        }, 'Playback session created');

        return {
          siloSessionId: decision.session_id || null,
          siloFileId: fileId,
          upstreamPath: '/api/v1' + plan.stream.url,
          delivery: plan.delivery
        };
      }
    );

    return { sessionResult, policy };
  }
}

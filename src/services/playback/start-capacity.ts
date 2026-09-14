export type PlaybackStartCapacityReason =
  | 'start_queue_full'
  | 'start_queue_timeout'
  | 'start_queue_closed';

export class PlaybackStartCapacityError extends Error {
  constructor(public readonly reason: PlaybackStartCapacityReason) {
    super('Playback start capacity is temporarily unavailable.');
    this.name = 'PlaybackStartCapacityError';
  }
}

interface PlaybackStartCapacityOptions {
  maxConcurrent?: () => number;
  maxQueued?: () => number;
  queueTimeoutMs?: () => number;
}

interface QueuedStart<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout | null;
}

function boundedInteger(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

/**
 * Bounds distinct Silo playback-start work without trying to duplicate Silo's
 * authoritative active stream, transcode, or node-capacity accounting.
 */
export class PlaybackStartCapacityGate {
  private readonly queue: Array<QueuedStart<unknown>> = [];
  private active = 0;
  private closed = false;

  constructor(private readonly options: PlaybackStartCapacityOptions = {}) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new PlaybackStartCapacityError('start_queue_closed')
      );
    }

    return new Promise<T>((resolve, reject) => {
      if (this.queue.length === 0 && this.active < this.maxConcurrent()) {
        this.start({ operation, resolve, reject });
        return;
      }

      if (this.queue.length >= this.maxQueued()) {
        reject(new PlaybackStartCapacityError('start_queue_full'));
        return;
      }

      const queued: QueuedStart<T> = {
        operation,
        resolve,
        reject,
        timer: null
      };
      queued.timer = setTimeout(() => {
        const index = this.queue.indexOf(queued as QueuedStart<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new PlaybackStartCapacityError('start_queue_timeout'));
      }, this.queueTimeoutMs());
      queued.timer.unref();
      this.queue.push(queued as QueuedStart<unknown>);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const queued of this.queue.splice(0)) {
      if (queued.timer) clearTimeout(queued.timer);
      queued.reject(new PlaybackStartCapacityError('start_queue_closed'));
    }
  }

  counts(): { active: number; queued: number } {
    return {
      active: this.active,
      queued: this.queue.length
    };
  }

  private start<T>(queued: Omit<QueuedStart<T>, 'timer'>): void {
    this.active += 1;
    void Promise.resolve()
      .then(queued.operation)
      .then(queued.resolve, queued.reject)
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
  }

  private drain(): void {
    while (
      !this.closed &&
      this.queue.length > 0 &&
      this.active < this.maxConcurrent()
    ) {
      const queued = this.queue.shift()!;
      if (queued.timer) clearTimeout(queued.timer);
      this.start(queued);
    }
  }

  private maxConcurrent(): number {
    return boundedInteger(this.options.maxConcurrent?.() ?? 2, 2, 1, 8);
  }

  private maxQueued(): number {
    return boundedInteger(this.options.maxQueued?.() ?? 4, 4, 0, 32);
  }

  private queueTimeoutMs(): number {
    return boundedInteger(
      this.options.queueTimeoutMs?.() ?? 15_000,
      15_000,
      1,
      60_000
    );
  }
}

import { describe, expect, it, vi } from 'vitest';
import {
  PlaybackStartCapacityError,
  PlaybackStartCapacityGate
} from '../src/services/playback/start-capacity.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

describe('playback start capacity gate', () => {
  it('runs distinct starts within the limit and drains its queue FIFO', async () => {
    const gate = new PlaybackStartCapacityGate({
      maxConcurrent: () => 1,
      maxQueued: () => 3,
      queueTimeoutMs: () => 1000
    });
    const firstRelease = deferred();
    const secondRelease = deferred();
    const order: string[] = [];

    const first = gate.run(async () => {
      order.push('first');
      await firstRelease.promise;
      return 1;
    });
    const second = gate.run(async () => {
      order.push('second');
      await secondRelease.promise;
      return 2;
    });
    const third = gate.run(async () => {
      order.push('third');
      return 3;
    });

    await vi.waitFor(() => expect(order).toEqual(['first']));
    expect(gate.counts()).toEqual({ active: 1, queued: 2 });
    firstRelease.resolve();
    await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
    secondRelease.resolve();

    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(gate.counts()).toEqual({ active: 0, queued: 0 });
  });

  it('rejects excess starts without disturbing admitted work', async () => {
    const gate = new PlaybackStartCapacityGate({
      maxConcurrent: () => 1,
      maxQueued: () => 1,
      queueTimeoutMs: () => 1000
    });
    const release = deferred();
    const first = gate.run(() => release.promise);
    const second = gate.run(async () => 'second');

    await expect(gate.run(async () => 'excess')).rejects.toMatchObject({
      name: 'PlaybackStartCapacityError',
      reason: 'start_queue_full'
    });
    expect(gate.counts()).toEqual({ active: 1, queued: 1 });

    release.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe('second');
  });

  it('times out only the queued start', async () => {
    const gate = new PlaybackStartCapacityGate({
      maxConcurrent: () => 1,
      maxQueued: () => 1,
      queueTimeoutMs: () => 10
    });
    const release = deferred();
    const first = gate.run(() => release.promise);

    await expect(gate.run(async () => 'queued')).rejects.toEqual(
      new PlaybackStartCapacityError('start_queue_timeout')
    );
    expect(gate.counts()).toEqual({ active: 1, queued: 0 });
    release.resolve();
    await first;
  });

  it('rejects queued and future work when closed while active work settles', async () => {
    const gate = new PlaybackStartCapacityGate({
      maxConcurrent: () => 1,
      maxQueued: () => 1,
      queueTimeoutMs: () => 1000
    });
    const release = deferred();
    const first = gate.run(() => release.promise);
    const queued = gate.run(async () => 'queued');
    const queuedResult = expect(queued).rejects.toMatchObject({
      reason: 'start_queue_closed'
    });

    gate.close();
    await queuedResult;
    await expect(gate.run(async () => 'late')).rejects.toMatchObject({
      reason: 'start_queue_closed'
    });
    expect(gate.counts()).toEqual({ active: 1, queued: 0 });

    release.resolve();
    await first;
    gate.close();
  });
});

import { describe, expect, it } from 'vitest';
import {
  HlsManifestError,
  isHlsManifestPath,
  readHlsManifest,
  rewriteHlsManifest
} from '../src/services/playback/hls-proxy.js';

describe('HLS proxy helpers', () => {
  const source = '/api/v1/playback/transcode/session-1/master.m3u8?generation=2';
  const baseUrl = 'http://silo:8080';
  const proxy = (path: string) => `proxy(${path})`;

  it('recognizes manifests with query strings', () => {
    expect(isHlsManifestPath('/playback/master.m3u8?token=value')).toBe(true);
    expect(isHlsManifestPath('/playback/segment.ts?token=value')).toBe(false);
  });

  it('rewrites nested URI lines and every HLS URI attribute form', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/index.m3u8?lang=en"',
      '#EXT-X-KEY:METHOD=AES-128,URI="http://silo:8080/api/v1/playback/transcode/session-1/key?id=3"',
      '#EXT-X-MAP:URI=init.mp4?part=1',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=900000,URI="iframe/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
      'video/index.m3u8?variant=high',
      ''
    ].join('\n');

    expect(rewriteHlsManifest(manifest, source, baseUrl, proxy)).toBe([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="proxy(/api/v1/playback/transcode/session-1/audio/index.m3u8?lang=en)"',
      '#EXT-X-KEY:METHOD=AES-128,URI="proxy(/api/v1/playback/transcode/session-1/key?id=3)"',
      '#EXT-X-MAP:URI=proxy(/api/v1/playback/transcode/session-1/init.mp4?part=1)',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=900000,URI="proxy(/api/v1/playback/transcode/session-1/iframe/index.m3u8)"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
      'proxy(/api/v1/playback/transcode/session-1/video/index.m3u8?variant=high)',
      ''
    ].join('\n'));
  });

  it('rejects off-origin and out-of-session media references', () => {
    expect(() => rewriteHlsManifest(
      '#EXTM3U\nhttps://example.com/api/v1/playback/session/segment.ts\n',
      source,
      baseUrl,
      proxy
    )).toThrow(HlsManifestError);

    expect(() => rewriteHlsManifest(
      '#EXTM3U\n../../../../health\n',
      source,
      baseUrl,
      proxy
    )).toThrow(HlsManifestError);
  });

  it('bounds buffered manifest text', async () => {
    const response = new Response('12345', {
      headers: { 'Content-Length': '5' }
    });
    await expect(readHlsManifest(response, 4)).rejects.toThrow(
      'oversized HLS manifest'
    );
  });
});

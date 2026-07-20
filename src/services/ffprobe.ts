import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ProbeStream {
  index?: number;
  codec_name?: string;
  codec_type?: 'video' | 'audio' | 'subtitle' | string;
  width?: number;
  height?: number;
  bit_rate?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  channel_layout?: string;
  tags?: { language?: string; title?: string };
}

interface ProbeOutput {
  format?: { filename?: string; duration?: string; bit_rate?: string; format_name?: string; size?: string };
  streams?: ProbeStream[];
  chapters?: unknown[];
}

export interface MediaProbe {
  durationSeconds: number | null;
  bitrate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  audioChannels: number | null;
  audioTracks: Array<{ index: number | null; codec: string | null; channels: number | null; layout: string | null; language: string | null; title: string | null }>;
  audioLanguages: string[];
  subtitleTracks: Array<{ index: number | null; codec: string | null; language: string | null; title: string | null }>;
  raw: ProbeOutput;
  compatibilityWarning: string | null;
}

function finiteNumber(value: string | number | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function frameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator) return finiteNumber(value);
  return numerator! / denominator!;
}

function compatibilityWarningFor(videoCodec: string | null, audioCodec: string | null, filePath: string): string | null {
  const warnings: string[] = [];
  if (videoCodec && !['h264', 'hevc', 'av1', 'vp8', 'vp9'].includes(videoCodec)) warnings.push(`video codec ${videoCodec}`);
  if (audioCodec && ['dts', 'truehd', 'pcm_s16le', 'pcm_s24le'].includes(audioCodec)) warnings.push(`audio codec ${audioCodec}`);
  if (/\.(avi|mov)$/i.test(filePath)) warnings.push('container may have limited direct-play support');
  return warnings.length ? `Direct playback may not be supported: ${warnings.join(', ')}` : null;
}

export async function inspectMedia(filePath: string, ffprobePath = 'ffprobe'): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', filePath
  ], { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const raw = JSON.parse(stdout) as ProbeOutput;
  if (raw.format) delete raw.format.filename;
  const streams = raw.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audios = streams.filter((stream) => stream.codec_type === 'audio');
  const audio = audios[0];
  const subtitles = streams.filter((stream) => stream.codec_type === 'subtitle');
  const videoCodec = video?.codec_name ?? null;
  const audioCodec = audio?.codec_name ?? null;
  return {
    durationSeconds: finiteNumber(raw.format?.duration),
    bitrate: finiteNumber(raw.format?.bit_rate),
    videoCodec,
    audioCodec,
    width: finiteNumber(video?.width),
    height: finiteNumber(video?.height),
    frameRate: frameRate(video?.avg_frame_rate || video?.r_frame_rate),
    audioChannels: finiteNumber(audio?.channels),
    audioTracks: audios.map((stream) => ({
      index: stream.index ?? null,
      codec: stream.codec_name ?? null,
      channels: finiteNumber(stream.channels),
      layout: stream.channel_layout ?? null,
      language: stream.tags?.language?.toLowerCase() ?? null,
      title: stream.tags?.title ?? null
    })),
    audioLanguages: [...new Set(audios.map((stream) => stream.tags?.language?.toLowerCase()).filter((value): value is string => Boolean(value)))],
    subtitleTracks: subtitles.map((stream) => ({
      index: stream.index ?? null,
      codec: stream.codec_name ?? null,
      language: stream.tags?.language?.toLowerCase() ?? null,
      title: stream.tags?.title ?? null
    })),
    raw,
    compatibilityWarning: compatibilityWarningFor(videoCodec, audioCodec, filePath)
  };
}

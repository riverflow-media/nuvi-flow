import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';

export const MAX_ADDON_ICON_BYTES =
  2 * 1024 * 1024;

export function addonIconPath(
  config: Pick<AppConfig, 'databasePath'>
): string {
  return path.join(
    path.dirname(config.databasePath),
    'addon-icon'
  );
}

export function detectAddonIconType(
  buffer: Buffer
): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export function defaultAddonIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6ee7b7"/>
      <stop offset="1" stop-color="#2dd4bf"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="130" fill="url(#g)"/>
  <text x="256" y="342" text-anchor="middle"
        font-family="Arial,Helvetica,sans-serif"
        font-size="300" font-weight="900"
        fill="#08201a">N</text>
</svg>`;
}

export async function writeAddonIcon(
  config: Pick<AppConfig, 'databasePath'>,
  buffer: Buffer
): Promise<void> {
  const destination =
    addonIconPath(config);

  await fs.promises.mkdir(
    path.dirname(destination),
    { recursive: true }
  );

  const temporary =
    `${destination}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.promises.writeFile(
      temporary,
      buffer,
      { mode: 0o600 }
    );

    await fs.promises.rename(
      temporary,
      destination
    );
  } finally {
    await fs.promises
      .unlink(temporary)
      .catch(() => {});
  }
}

export async function removeAddonIcon(
  config: Pick<AppConfig, 'databasePath'>
): Promise<void> {
  try {
    await fs.promises.unlink(
      addonIconPath(config)
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)
        .code !== 'ENOENT'
    ) {
      throw error;
    }
  }
}

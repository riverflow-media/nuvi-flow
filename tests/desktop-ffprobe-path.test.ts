import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveFfprobePath } = require('../desktop/ffprobe-path.cjs') as {
  resolveFfprobePath: (moduleExport: unknown, isPackaged?: boolean) => string;
};

describe('desktop ffprobe path resolution', () => {
  it('reads the object export used by ffprobe-static 3.x', () => {
    expect(resolveFfprobePath({ path: 'C:\\app\\ffprobe.exe' })).toBe('C:\\app\\ffprobe.exe');
  });

  it('supports legacy string and default exports', () => {
    expect(resolveFfprobePath('/app/ffprobe')).toBe('/app/ffprobe');
    expect(resolveFfprobePath({ default: { path: '/app/ffprobe' } })).toBe('/app/ffprobe');
  });

  it('maps packaged binaries from app.asar to app.asar.unpacked', () => {
    expect(resolveFfprobePath({ path: 'C:\\Program Files\\Personal Media Addon\\resources\\app.asar\\node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe.exe' }, true))
      .toBe('C:\\Program Files\\Personal Media Addon\\resources\\app.asar.unpacked\\node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe.exe');
  });

  it('fails with a useful message when no executable path is exported', () => {
    expect(() => resolveFfprobePath({})).toThrow('The bundled ffprobe executable could not be located.');
  });
});

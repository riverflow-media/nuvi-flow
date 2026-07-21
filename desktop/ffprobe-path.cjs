function resolveFfprobePath(moduleExport, isPackaged = false) {
  const candidate = typeof moduleExport === 'string'
    ? moduleExport
    : moduleExport?.path ?? moduleExport?.default?.path ?? moduleExport?.default;

  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error('The bundled ffprobe executable could not be located.');
  }

  if (!isPackaged) return candidate;
  return candidate.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

module.exports = { resolveFfprobePath };

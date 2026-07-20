export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function safePublicError(error: unknown): string {
  if (error instanceof Error && ['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) {
    return 'The media file is currently unavailable.';
  }
  return 'The request could not be completed.';
}

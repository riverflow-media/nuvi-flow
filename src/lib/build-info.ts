export interface BuildInfo {
  version: string;
  revision: string;
}

function clean(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate ? candidate.slice(0, 128) : fallback;
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const revision = clean(env.NUVI_FLOW_REVISION, 'dev');
  return {
    version: clean(env.NUVI_FLOW_VERSION, '1.1.1'),
    revision: revision === 'unknown' ? 'dev' : revision.slice(0, 12)
  };
}

import { createHash } from 'node:crypto';

export type DeviceIdentitySource =
  | 'explicit'
  | 'client_hints'
  | 'request_scope';

export interface DeviceIdentity {
  id: string;
  source: DeviceIdentitySource;
}

export interface DeviceIdentityInput {
  installationId: string;
  explicitDeviceId?: string;
  clientName?: string;
  clientVersion?: string;
  userAgent?: string;
  ip?: string;
  requestScope?: string;
}

function clean(value: string | undefined): string {
  return value?.trim().slice(0, 512) || '';
}

export function deriveDeviceIdentity(
  input: DeviceIdentityInput
): DeviceIdentity {
  const installationId = clean(input.installationId);
  const explicitDeviceId = clean(input.explicitDeviceId);
  const clientName = clean(input.clientName);
  const clientVersion = clean(input.clientVersion);
  const userAgent = clean(input.userAgent);
  const ip = clean(input.ip);
  const requestScope = clean(input.requestScope);

  let source: DeviceIdentitySource;
  let material: string[];

  if (explicitDeviceId) {
    source = 'explicit';
    material = [
      source,
      installationId,
      explicitDeviceId
    ];
  } else if (clientName || clientVersion || userAgent) {
    source = 'client_hints';
    material = [
      source,
      installationId,
      clientName,
      clientVersion,
      userAgent,
      ip
    ];
  } else {
    source = 'request_scope';
    material = [
      source,
      installationId,
      ip,
      requestScope
    ];
  }

  const digest = createHash('sha256')
    .update(JSON.stringify(material))
    .digest('hex')
    .slice(0, 24);

  return {
    id: `device_${digest}`,
    source
  };
}

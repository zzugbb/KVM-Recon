import { createNodeProbeHttpClient } from './createNodeProbeHttpClient';
import { probeBmcBasics, type ProbeBmcBasicsResult, type ProbeHttpClient } from './probeBmcBasics';
import { probeTlsInfo, type TlsProbeResult } from './probeTlsInfo';
import type { BmcTarget } from './types';

interface TlsConnectorResult {
  authorized: boolean;
  authorizationError?: string;
  protocol: string | null;
  cipher: { name: string; version: string } | null;
  certificate: {
    subject?: Record<string, string | undefined>;
    issuer?: Record<string, string | undefined>;
    subjectaltname?: string;
    valid_from?: string;
    valid_to?: string;
  } | null;
}

interface ProbeBmcTargetInput {
  target: BmcTarget;
  httpClient?: ProbeHttpClient;
  tlsConnector?: () => Promise<TlsConnectorResult>;
}

export interface ProbeBmcTargetResult extends ProbeBmcBasicsResult {
  tls: TlsProbeResult;
  authenticated?: { attempted: boolean; cookieNames: string[] };
}

export async function probeBmcTarget(input: ProbeBmcTargetInput): Promise<ProbeBmcTargetResult> {
  const [basics, tls] = await Promise.all([
    probeBmcBasics({
      target: input.target,
      httpClient: input.httpClient || createNodeProbeHttpClient(input.target),
    }),
    probeTlsInfo({ target: input.target, connector: input.tlsConnector }),
  ]);
  return { ...basics, tls };
}

export function applyAuthenticatedProbe(
  anonymous: ProbeBmcTargetResult,
  authenticated: ProbeBmcTargetResult,
  cookieNames: string[],
): ProbeBmcTargetResult {
  return {
    ...anonymous,
    basic: {
      ...anonymous.basic,
      vendor: anonymous.basic.vendor || authenticated.basic.vendor,
      product: anonymous.basic.product || authenticated.basic.product,
      firmwareVersion: anonymous.basic.firmwareVersion || authenticated.basic.firmwareVersion,
    },
    redfish: anonymous.redfish.reachable ? anonymous.redfish : authenticated.redfish,
    authenticated: {
      attempted: true,
      cookieNames: [...new Set(cookieNames.filter(Boolean))],
    },
  };
}

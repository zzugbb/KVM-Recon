import type { CaptureTarget } from '../capture-pack/types';
import { createNodeProbeHttpClient } from './createNodeProbeHttpClient';
import { probeBmcBasics, type ProbeBmcBasicsResult, type ProbeHttpClient } from './probeBmcBasics';
import { probeTlsInfo, type TlsProbeResult } from './probeTlsInfo';

interface TlsConnectorResult {
  authorized: boolean;
  authorizationError?: string;
  protocol: string | null;
  cipher: {
    name: string;
    version: string;
  } | null;
  certificate: {
    subject?: Record<string, string | undefined>;
    issuer?: Record<string, string | undefined>;
    subjectaltname?: string;
    valid_from?: string;
    valid_to?: string;
  } | null;
}

interface ProbeBmcTargetInput {
  target: CaptureTarget;
  httpClient?: ProbeHttpClient;
  tlsConnector?: () => Promise<TlsConnectorResult>;
}

export interface ProbeBmcTargetResult extends ProbeBmcBasicsResult {
  tls: TlsProbeResult;
}

export async function probeBmcTarget(input: ProbeBmcTargetInput): Promise<ProbeBmcTargetResult> {
  const httpClient = input.httpClient || createNodeProbeHttpClient(input.target);
  const [basics, tls] = await Promise.all([
    probeBmcBasics({
      target: input.target,
      httpClient,
    }),
    probeTlsInfo({
      target: input.target,
      connector: input.tlsConnector,
    }),
  ]);

  return {
    ...basics,
    tls,
  };
}

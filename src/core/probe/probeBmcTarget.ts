import type { CaptureTarget } from '../capture-pack/types';
import { detectKvmFamily, type ProbeSignatureInput } from '../signatures/detectKvmFamily';
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
  authenticated?: {
    attempted: boolean;
    cookieNames: string[];
    paths: NonNullable<ProbeSignatureInput['paths']>;
  };
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

export function mergePathEvidence(
  base: NonNullable<ProbeSignatureInput['paths']> = {},
  extra: NonNullable<ProbeSignatureInput['paths']> = {},
): NonNullable<ProbeSignatureInput['paths']> {
  const merged: NonNullable<ProbeSignatureInput['paths']> = { ...base };
  for (const [key, value] of Object.entries(extra) as Array<
    [keyof NonNullable<ProbeSignatureInput['paths']>, boolean | undefined]
  >) {
    merged[key] = Boolean(merged[key] || value);
  }
  return merged;
}

export function applyAuthenticatedProbe(
  anonymous: ProbeBmcTargetResult,
  authenticated: ProbeBmcTargetResult,
  cookieNames: string[],
): ProbeBmcTargetResult {
  const paths = mergePathEvidence(anonymous.paths, authenticated.paths);
  const vendor = anonymous.basic.vendor || authenticated.basic.vendor;
  const product = anonymous.basic.product || authenticated.basic.product;
  return {
    ...anonymous,
    basic: {
      ...anonymous.basic,
      vendor,
      product,
      firmwareVersion: anonymous.basic.firmwareVersion || authenticated.basic.firmwareVersion,
    },
    paths,
    familySignatures: detectKvmFamily({
      redfish: { vendor, product },
      paths,
    }),
    authenticated: {
      attempted: true,
      cookieNames: [...new Set(cookieNames.filter(Boolean))],
      paths: authenticated.paths,
    },
  };
}

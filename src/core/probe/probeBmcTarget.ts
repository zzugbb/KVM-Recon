import type { CaptureTarget } from '../capture-pack/types';
import {
  detectKvmFamily,
  overlayPathEvidence,
  tlsCommonNameFromCertificate,
  tlsOrganizationFromCertificate,
  type ProbeSignatureInput,
} from '../signatures/detectKvmFamily';
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
    pathDetails?: ProbeBmcBasicsResult['pathDetails'];
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
    familySignatures: detectKvmFamily({
      redfish: {
        vendor: basics.basic.vendor,
        product: basics.basic.product,
      },
      paths: basics.paths,
      tls: {
        organization: tlsOrganizationFromCertificate(tls.certificate),
        commonName: tlsCommonNameFromCertificate(tls.certificate),
      },
    }),
  };
}

export { overlayPathEvidence };

export function applyAuthenticatedProbe(
  anonymous: ProbeBmcTargetResult,
  authenticated: ProbeBmcTargetResult,
  cookieNames: string[],
): ProbeBmcTargetResult {
  const paths = overlayPathEvidence(anonymous.paths, authenticated.paths);
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
    tls: {
      organization: tlsOrganizationFromCertificate(anonymous.tls.certificate),
      commonName: tlsCommonNameFromCertificate(anonymous.tls.certificate),
    },
    }),
    authenticated: {
      attempted: true,
      cookieNames: [...new Set(cookieNames.filter(Boolean))],
      paths: authenticated.paths,
      pathDetails: authenticated.pathDetails,
    },
  };
}

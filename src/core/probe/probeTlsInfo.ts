import tls from 'node:tls';

import type { CaptureTarget } from '../capture-pack/types';
import { tlsServerName } from './tlsServerName';

interface CertificateParty {
  CN?: string | string[];
  [key: string]: string | string[] | undefined;
}

interface PeerCertificate {
  subject?: CertificateParty;
  issuer?: CertificateParty;
  subjectaltname?: string;
  valid_from?: string;
  valid_to?: string;
}

interface TlsConnectorResult {
  authorized: boolean;
  authorizationError?: string;
  protocol: string | null;
  cipher: {
    name: string;
    version: string;
  } | null;
  certificate: PeerCertificate | null;
}

export interface TlsProbeResult {
  reachable: boolean;
  authorized: boolean;
  authorizationError: string;
  protocol: string;
  cipher: {
    name: string;
    version: string;
  } | null;
  certificate: {
    subject: CertificateParty;
    issuer: CertificateParty;
    subjectaltname: string;
    validFrom: string;
    validTo: string;
    selfSigned: boolean;
  } | null;
  chromium?: {
    reachable: boolean;
    authorizationError: string;
  };
}

interface ProbeTlsInfoInput {
  target: CaptureTarget;
  connector?: () => Promise<TlsConnectorResult>;
}

function isSelfSigned(certificate: PeerCertificate | null) {
  if (!certificate?.subject || !certificate.issuer) return false;
  const subjectCn = Array.isArray(certificate.subject.CN)
    ? certificate.subject.CN.join(',')
    : certificate.subject.CN || '';
  const issuerCn = Array.isArray(certificate.issuer.CN)
    ? certificate.issuer.CN.join(',')
    : certificate.issuer.CN || '';
  return !!subjectCn && subjectCn === issuerCn;
}

function createDefaultConnector(target: CaptureTarget): () => Promise<TlsConnectorResult> {
  return () =>
    new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: target.host,
        port: target.port,
        servername: tlsServerName(target.host),
        rejectUnauthorized: false,
        timeout: 8000,
      });

      socket.once('secureConnect', () => {
        const cipher = socket.getCipher();
        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError
            ? String(socket.authorizationError)
            : '',
          protocol: socket.getProtocol(),
          cipher: cipher
            ? {
                name: cipher.name,
                version: cipher.version,
              }
            : null,
          certificate: socket.getPeerCertificate(),
        });
        socket.end();
      });

      socket.once('timeout', () => {
        socket.destroy(new Error('TLS probe timed out'));
      });
      socket.once('error', reject);
    });
}

export async function probeTlsInfo(input: ProbeTlsInfoInput): Promise<TlsProbeResult> {
  if (input.target.scheme !== 'https') {
    return {
      reachable: false,
      authorized: false,
      authorizationError: 'not_https',
      protocol: '',
      cipher: null,
      certificate: null,
    };
  }

  try {
    const connector = input.connector || createDefaultConnector(input.target);
    const result = await connector();
    const certificate = result.certificate;

    return {
      reachable: true,
      authorized: result.authorized,
      authorizationError: result.authorizationError || '',
      protocol: result.protocol || '',
      cipher: result.cipher,
      certificate: certificate
        ? {
            subject: certificate.subject || {},
            issuer: certificate.issuer || {},
            subjectaltname: certificate.subjectaltname || '',
            validFrom: certificate.valid_from || '',
            validTo: certificate.valid_to || '',
            selfSigned: isSelfSigned(certificate),
          }
        : null,
    };
  } catch (error) {
    return {
      reachable: false,
      authorized: false,
      authorizationError: error instanceof Error ? error.message : String(error),
      protocol: '',
      cipher: null,
      certificate: null,
    };
  }
}

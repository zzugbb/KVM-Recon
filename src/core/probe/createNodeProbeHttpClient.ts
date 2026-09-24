import http from 'node:http';
import https from 'node:https';

import type { ProbeHttpClient, ProbeHttpResponse } from './probeBmcBasics';
import { tlsServerName } from './tlsServerName';
import type { BmcTarget } from './types';

export const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

function parseResponseBody(buffer: Buffer, contentType: string): unknown {
  const text = buffer.toString('utf8');
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 128).toLowerCase();
  const looksHtml =
    head.startsWith('<!doctype') || head.startsWith('<html') || /^<html[\s>]/.test(head);
  const looksJson = head.startsWith('{') || head.startsWith('[');
  if (contentType.toLowerCase().includes('application/json') || (looksJson && !looksHtml)) {
    try {
      return JSON.parse(text);
    } catch {
      // 捕获 JSON 解析失败：保留原始文本摘要，避免探测因非标准 BMC 响应中断
      return text;
    }
  }
  return text;
}

export function createNodeProbeHttpClient(
  target: BmcTarget,
  options: {
    extraHeaders?: Record<string, string>;
    extraHeadersForPath?: (path: string) => Promise<Record<string, string>>;
  } = {},
): ProbeHttpClient {
  return {
    async get(path: string): Promise<ProbeHttpResponse> {
      const transport = target.scheme === 'https' ? https : http;
      const agent =
        target.scheme === 'https'
          ? new https.Agent({
              rejectUnauthorized: false,
            })
          : undefined;
      const pathHeaders = (await options.extraHeadersForPath?.(path)) || {};

      return new Promise((resolve, reject) => {
        let settled = false;
        const rejectOnce = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const request = transport.request(
          {
            hostname: target.host,
            port: target.port,
            path,
            method: 'GET',
            agent,
            timeout: 8000,
            headers: {
              Accept: 'application/json, */*;q=0.1',
              ...options.extraHeaders,
              ...pathHeaders,
            },
            servername: tlsServerName(target.host),
          },
          response => {
            const chunks: Buffer[] = [];
            let receivedBytes = 0;
            const declaredBytes = Number(response.headers['content-length'] || 0);
            if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PROBE_RESPONSE_BYTES) {
              response.destroy();
              rejectOnce(
                new Error(`Probe GET ${path} response exceeds ${MAX_PROBE_RESPONSE_BYTES} bytes`),
              );
              return;
            }
            response.on('data', chunk => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              receivedBytes += buffer.length;
              if (receivedBytes > MAX_PROBE_RESPONSE_BYTES) {
                response.destroy();
                rejectOnce(
                  new Error(`Probe GET ${path} response exceeds ${MAX_PROBE_RESPONSE_BYTES} bytes`),
                );
                return;
              }
              chunks.push(buffer);
            });
            response.on('end', () => {
              if (settled) return;
              settled = true;
              resolve({
                status: response.statusCode || 0,
                headers: response.headers as Record<string, string | string[] | undefined>,
                redirected: Boolean(
                  response.statusCode && response.statusCode >= 300 && response.statusCode < 400,
                ),
                redirectLocation: Array.isArray(response.headers.location)
                  ? response.headers.location[0] || ''
                  : String(response.headers.location || ''),
                data: parseResponseBody(
                  Buffer.concat(chunks),
                  String(response.headers['content-type'] || ''),
                ),
              });
            });
          },
        );

        request.on('timeout', () => {
          request.destroy(new Error(`Probe GET ${path} timed out`));
        });
        request.on('error', rejectOnce);
        request.end();
      });
    },
  };
}

import http from 'node:http';
import https from 'node:https';

import type { CaptureTarget } from '../capture-pack/types';
import type { ProbeHttpClient, ProbeHttpResponse } from './probeBmcBasics';
import { tlsServerName } from './tlsServerName';

function parseResponseBody(buffer: Buffer, contentType: string): unknown {
  const text = buffer.toString('utf8');
  if (contentType.toLowerCase().includes('application/json')) {
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
  target: CaptureTarget,
  options: { extraHeaders?: Record<string, string> } = {},
): ProbeHttpClient {
  return {
    get(path: string): Promise<ProbeHttpResponse> {
      const transport = target.scheme === 'https' ? https : http;
      const agent =
        target.scheme === 'https'
          ? new https.Agent({
              rejectUnauthorized: false,
            })
          : undefined;

      return new Promise((resolve, reject) => {
        const request = transport.request(
          {
            hostname: target.host,
            port: target.port,
            path,
            method: 'GET',
            agent,
            timeout: 8000,
            headers: {
              Host: target.host,
              Accept: 'application/json, */*;q=0.1',
              ...options.extraHeaders,
            },
            servername: tlsServerName(target.host),
          },
          response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on('end', () => {
              resolve({
                status: response.statusCode || 0,
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
        request.on('error', reject);
        request.end();
      });
    },
  };
}

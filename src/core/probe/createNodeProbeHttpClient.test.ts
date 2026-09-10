import { createServer, type RequestListener, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createNodeProbeHttpClient } from './createNodeProbeHttpClient';

let server: Server | null = null;

function startServer(handler: RequestListener) {
  server = createServer(handler);

  return new Promise<{ port: number }>(resolve => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address() as AddressInfo;
      resolve({ port: address.port });
    });
  });
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>(resolve => {
    server!.close(() => resolve());
  });
  server = null;
});

describe('createNodeProbeHttpClient', () => {
  it('performs GET requests and parses JSON responses', async () => {
    const { port } = await startServer((request, response) => {
      if (request.url === '/redfish/v1') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ Vendor: 'OpenBMC', Product: 'Test BMC' }));
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });

    const client = createNodeProbeHttpClient({
      host: '127.0.0.1',
      port,
      scheme: 'http',
    });

    await expect(client.get('/redfish/v1')).resolves.toMatchObject({
      status: 200,
      data: { Vendor: 'OpenBMC', Product: 'Test BMC' },
      headers: { 'content-type': 'application/json' },
      redirected: false,
      redirectLocation: '',
    });
    await expect(client.get('/missing')).resolves.toMatchObject({
      status: 404,
      data: 'not found',
      redirected: false,
      redirectLocation: '',
    });
  });

  it('sends extra session headers for authenticated probes', async () => {
    const seen: string[] = [];
    const { port } = await startServer((request, response) => {
      seen.push(String(request.headers.cookie || ''));
      response.statusCode = 401;
      response.end('auth required');
    });

    const client = createNodeProbeHttpClient(
      {
        host: '127.0.0.1',
        port,
        scheme: 'http',
      },
      { extraHeaders: { Cookie: 'QSESSIONID=abc123' } },
    );

    await expect(client.get('/api/kvm/token')).resolves.toMatchObject({ status: 401 });
    expect(seen[0]).toBe('QSESSIONID=abc123');
  });
});

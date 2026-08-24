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

    await expect(client.get('/redfish/v1')).resolves.toEqual({
      status: 200,
      data: { Vendor: 'OpenBMC', Product: 'Test BMC' },
    });
    await expect(client.get('/missing')).resolves.toEqual({
      status: 404,
      data: 'not found',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { probeBmcBasics, type ProbeHttpClient } from './probeBmcBasics';

const target = { host: 'bmc.example', port: 443, scheme: 'https' } as const;

describe('probeBmcBasics', () => {
  it('只探测标准 Redfish 根并记录原始产品字段', async () => {
    const calls: string[] = [];
    const httpClient: ProbeHttpClient = {
      async get(path) {
        calls.push(path);
        return {
          status: 200,
          data: {
            Vendor: 'Vendor X',
            Product: 'Model 42',
            FirmwareVersion: '1.2.3',
            Oem: { Custom: { Build: 'a' } },
          },
        };
      },
    };
    const result = await probeBmcBasics({ target, httpClient });
    expect(calls).toEqual(['/redfish/v1/']);
    expect(result.basic).toEqual({
      ...target,
      vendor: 'Vendor X',
      product: 'Model 42',
      firmwareVersion: '1.2.3',
    });
    expect(result.redfish).toMatchObject({
      reachable: true,
      path: '/redfish/v1/',
      oemKeys: ['Custom'],
      rootFields: { Vendor: 'Vendor X', Product: 'Model 42' },
      body: { Oem: { Custom: { Build: 'a' } } },
    });
    expect(result).not.toHaveProperty('familySignatures');
    expect(result).not.toHaveProperty('paths');
  });

  it('根带斜杠不可用时尝试无斜杠地址', async () => {
    const calls: string[] = [];
    const result = await probeBmcBasics({
      target,
      httpClient: {
        async get(path) {
          calls.push(path);
          return path === '/redfish/v1/'
            ? { status: 404 }
            : { status: 200, data: { Vendor: 'Any BMC' } };
        },
      },
    });
    expect(calls).toEqual(['/redfish/v1/', '/redfish/v1']);
    expect(result.redfish.path).toBe('/redfish/v1');
    expect(result.basic.vendor).toBe('Any BMC');
  });

  it('Redfish 不存在或网络失败仍返回空事实，不中断采集', async () => {
    const result = await probeBmcBasics({
      target,
      httpClient: { async get() { throw new Error('unreachable'); } },
    });
    expect(result.redfish.reachable).toBe(false);
    expect(result.basic.vendor).toBe('');
  });

  it('登录页 HTML 不能当作 Redfish 产品事实', async () => {
    const result = await probeBmcBasics({
      target,
      httpClient: {
        async get() {
          return { status: 200, data: '<html>login</html>' };
        },
      },
    });
    expect(result.redfish.reachable).toBe(false);
    expect(result.basic.product).toBe('');
  });
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { summarizeCapturePackZip } from '../capture-pack/summarizeCapturePack';
import type { HttpRequestRecord } from '../network/createNetworkRecorder';
import { buildReadinessChecklist } from '../readiness/buildReadinessChecklist';
import { isExplicitKvmLaunchRequest } from '../readiness/kvmLaunchCorrelation';
import { materialInFlightRequestIds } from '../readiness/networkCaptureCompleteness';
import { scoreCapturedKvmFamily } from '../signatures/detectKvmFamily';

// 只通过 KVM_RECON_FIELD_PACKS 指向真实 zip 目录；未设置或目录不存在时跳过，避免把本机路径写进仓库。
const FIELD_PACK_DIR = process.env.KVM_RECON_FIELD_PACKS?.trim() || '';
const available = Boolean(FIELD_PACK_DIR) && existsSync(FIELD_PACK_DIR);

function parseJsonl(text: string): unknown[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as unknown];
      } catch (error) {
        // 捕获现场 jsonl 单行损坏：其余记录仍可用于离线回归
        // 策略：跳过该行，不把整个 zip 判失败
        void error;
        return [];
      }
    });
}

function findPack(hostPart: string) {
  const name = readdirSync(FIELD_PACK_DIR).find(
    file => file.includes(hostPart) && file.endsWith('.zip'),
  );
  if (!name) throw new Error(`missing field pack for ${hostPart}`);
  return join(FIELD_PACK_DIR, name);
}

async function loadPack(hostPart: string) {
  const bytes = new Uint8Array(readFileSync(findPack(hostPart)));
  const zip = await JSZip.loadAsync(bytes);
  const readJson = async (path: string) => {
    const file = zip.file(path);
    return file ? (JSON.parse(await file.async('string')) as unknown) : null;
  };
  const readText = async (path: string) => {
    const file = zip.file(path);
    return file ? file.async('string') : '';
  };
  return {
    requests: parseJsonl(await readText('http/requests.jsonl')) as HttpRequestRecord[],
    sockets: ((await readJson('ws/sockets.json')) as unknown[]) || [],
    frames: parseJsonl(await readText('ws/frames.jsonl')),
    captureStatus: ((await readJson('http/capture-status.json')) as Record<string, unknown>) || {},
    sources: ((await readJson('http/sources.json')) as { files?: Array<{ url?: string }> }) || {},
    summary: await summarizeCapturePackZip(bytes),
  };
}

function hasSourceUrl(pack: { sources: { files?: Array<{ url?: string }> } }, pattern: RegExp) {
  return (pack.sources.files || []).some(file => typeof file.url === 'string' && pattern.test(file.url));
}

describe.skipIf(!available)('offline regression against 2026-09-15 field packs', () => {
  it('keeps the OpenBMC YES pack as YES', async () => {
    const pack = await loadPack('10-125-236-160');
    expect(pack.summary.readiness).toBe('YES');
    expect(pack.summary.family).toBe('openbmc-h5');
  });

  it('recognizes 10.130.34.1 h5viewercfg as a key AMI launch API without inventing worker source', async () => {
    const pack = await loadPack('10-130-34-1');
    const cfg = pack.requests.filter(item => /\/api\/settings\/media\/h5viewercfg/i.test(item.url));
    expect(cfg.length).toBeGreaterThan(0);
    expect(cfg.some(item => isExplicitKvmLaunchRequest(item))).toBe(true);
    expect(
      scoreCapturedKvmFamily(
        {
          basic: { vendor: '', product: '' },
          paths: {},
        },
        { httpRequests: pack.requests },
      ).primary,
    ).toBe('ami-megarac');
    const rebuilt = buildReadinessChecklist({
      probe: {
        basic: {
          host: '10.130.34.1',
          port: 443,
          scheme: 'https',
          vendor: '',
          product: '',
          firmwareVersion: '',
        },
        paths: {},
        familySignatures: { primary: 'ami-megarac', confidence: 0.9, candidates: [] },
        tls: {
          reachable: true,
          authorized: false,
          authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
          protocol: 'TLSv1.2',
          cipher: null,
          certificate: null,
        },
      },
      page: { jobId: pack.summary.jobId, events: [] },
      network: {
        httpRequests: pack.requests,
        webSockets: pack.sockets as never,
        webSocketFrames: pack.frames as never,
      },
      networkIdle: pack.captureStatus as never,
      redaction: { status: 'pass', redactedFields: 1 },
    });
    expect(rebuilt.items.find(item => item.id === 'http.key_api')?.status).toBe('pass');
    expect(hasSourceUrl(pack, /\/decode_worker\.js(?:[?#]|$)/i)).toBe(false);
  });

  it('does not treat missing Worker bodies in old PARTIAL packs as captured', async () => {
    const ami = await loadPack('10-128-4-88');
    const openbmc = await loadPack('10-128-6-235');
    expect(ami.summary.readiness).toBe('PARTIAL');
    expect(openbmc.summary.readiness).toBe('PARTIAL');
    expect(hasSourceUrl(ami, /\/decode_worker\.js(?:[?#]|$)/i)).toBe(false);
    expect(hasSourceUrl(openbmc, /\/DecodeWorker\.js(?:[?#]|$)/i)).toBe(false);
    const inflight = Array.isArray(openbmc.captureStatus.inFlightRequestIds)
      ? (openbmc.captureStatus.inFlightRequestIds as string[])
      : [];
    const material = materialInFlightRequestIds(inflight, openbmc.requests);
    const kvmServiceInFlight = inflight.filter(id => {
      const request = openbmc.requests.find(item => item.id === id);
      return Boolean(request && /kvmservice/i.test(request.url));
    });
    expect(kvmServiceInFlight.length).toBeGreaterThan(0);
    expect(kvmServiceInFlight.every(id => !material.includes(id))).toBe(true);
    expect(
      material.some(id => {
        const request = openbmc.requests.find(item => item.id === id);
        return Boolean(request && /worker/i.test(request.url));
      }),
    ).toBe(true);
  });
});

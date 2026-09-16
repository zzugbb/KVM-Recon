import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import type { HttpRequestRecord, WebSocketFrameRecord, WebSocketRecord } from '../network/createNetworkRecorder';
import { adapterSourceCoverage, pageReferencedScriptsFromEvents } from '../network/sourceCapture';
import type { ProbeBmcTargetResult } from '../probe/probeBmcTarget';
import { buildReadinessChecklist, reliableKvmWindows } from '../readiness/buildReadinessChecklist';
import { criticalPayloadGaps } from '../readiness/kvmLaunchCorrelation';
import { detectProductHints } from '../signatures/detectProductHints';

const FIELD_DIR = process.env.KVM_RECON_FIELD_COLLECTION_2?.trim() || '';
const available = Boolean(FIELD_DIR) && existsSync(FIELD_DIR);

function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function fieldFile(hostPart: string, extension: '.zip' | '.har', suffix = '') {
  const name = readdirSync(FIELD_DIR).find(file => {
    if (!file.endsWith(extension)) return false;
    if (extension === '.zip') return file.includes(hostPart);
    return file === `${hostPart.replaceAll('-', '.')}${suffix}.har`;
  });
  if (!name) throw new Error(`missing field file for ${hostPart}${suffix}${extension}`);
  return join(FIELD_DIR, name);
}

async function loadPack(hostPart: string) {
  const zip = await JSZip.loadAsync(new Uint8Array(readFileSync(fieldFile(hostPart, '.zip'))));
  const text = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`missing ${path} in ${hostPart}`);
    return file.async('string');
  };
  const json = async <T>(path: string) => JSON.parse(await text(path)) as T;
  const manifest = await json<{
    job: { id: string; observed?: { vendor?: string; product?: string; firmware?: string } };
    family: { primary: string };
    readiness: { status: string };
  }>('manifest.json');
  const requests = parseJsonl<HttpRequestRecord>(await text('http/requests.jsonl'));
  const sockets = await json<WebSocketRecord[]>('ws/sockets.json');
  const frames = parseJsonl<WebSocketFrameRecord>(await text('ws/frames.jsonl'));
  const events = parseJsonl<Array<{ type: string; [key: string]: unknown }>[number]>(
    await text('page/timeline.jsonl'),
  );
  const basic = await json<ProbeBmcTargetResult['basic']>('probe/bmc-basic.json');
  const paths = await json<ProbeBmcTargetResult['paths']>('probe/path-evidence.json');
  const tls = await json<ProbeBmcTargetResult['tls']>('tls/certificate.json');
  const probe: ProbeBmcTargetResult = {
    basic,
    paths,
    tls,
    familySignatures: {
      primary: manifest.family.primary as ProbeBmcTargetResult['familySignatures']['primary'],
      confidence: 0,
      candidates: [],
    },
  };
  const network = { httpRequests: requests, webSockets: sockets, webSocketFrames: frames };
  return { manifest, probe, network, page: { jobId: manifest.job.id, events } };
}

function productHints(pack: Awaited<ReturnType<typeof loadPack>>) {
  return detectProductHints({
    redfish: { vendor: pack.probe.basic.vendor, product: pack.probe.basic.product },
    observed: pack.manifest.job.observed,
    traffic: {
      httpUrls: pack.network.httpRequests.map(request => request.url),
      webSocketUrls: pack.network.webSockets.map(socket => socket.url),
      frameHeads: pack.network.webSocketFrames.map(frame => frame.magic || frame.headHex),
      frameHeadHexes: pack.network.webSocketFrames.map(frame => frame.headHex),
    },
  });
}

function rebuiltChecklist(pack: Awaited<ReturnType<typeof loadPack>>) {
  return buildReadinessChecklist({
    probe: pack.probe,
    page: pack.page,
    network: pack.network,
    redaction: { status: 'pass', redactedFields: 1 },
  });
}

function readHar(hostPart: string, suffix = '') {
  const har = JSON.parse(readFileSync(fieldFile(hostPart, '.har', suffix), 'utf8')) as {
    log?: { entries?: Array<{ request?: { url?: string; method?: string }; response?: { content?: { text?: string } } }> };
  };
  return har.log?.entries || [];
}

function hasHarBody(hostPart: string, pattern: RegExp, suffix = '') {
  return readHar(hostPart, suffix).some(entry => {
    const url = entry.request?.url || '';
    return pattern.test(url) && Boolean(entry.response?.content?.text);
  });
}

describe.skipIf(!available)('offline regression against field collection 2', () => {
  it('loads the complete read-only corpus', () => {
    const files = readdirSync(FIELD_DIR);
    expect(files.filter(file => file.endsWith('.zip'))).toHaveLength(27);
    expect(files.filter(file => file.endsWith('.har'))).toHaveLength(16);
  });

  it.each(['10-10-8-129', '10-10-8-132', '10-10-8-121'])(
    'keeps H3C HDM2 sample %s complete and product-specific',
    async host => {
      const pack = await loadPack(host);
      expect(pack.manifest.readiness.status).toBe('YES');
      expect(productHints(pack)[0]?.productFamily).toBe('h3c-hdm2');
    },
  );

  it.each([
    '10-10-8-80',
    '10-10-8-109',
    '10-10-9-6',
    '10-10-8-86',
    '10-10-8-88',
    '10-10-8-101',
  ])(
    'recognizes Dell sample %s without HPE contamination or a fake login body gap',
    async host => {
      const pack = await loadPack(host);
      const hints = productHints(pack).map(hint => hint.productFamily);
      expect(hints).toContain('dell-idrac-h5');
      expect(hints).not.toContain('hpe-ilo-h5');
      expect(criticalPayloadGaps(pack.network.httpRequests)).not.toEqual(
        expect.arrayContaining([expect.stringContaining('login-request-body-missing')]),
      );
      expect(rebuiltChecklist(pack).items.find(item => item.id === 'http.key_payload')?.status).toBe(
        'pass',
      );
    },
  );

  it('covers both Dell RFB and APCP/DVC WebSocket variants', async () => {
    for (const host of ['10-10-8-109', '10-10-8-86', '10-10-8-101']) {
      const pack = await loadPack(host);
      expect(pack.network.webSockets.some(socket => /\/v[mn]c\/vconsole/i.test(socket.url))).toBe(
        true,
      );
    }
    for (const host of ['10-10-8-80', '10-10-8-88', '10-10-9-6']) {
      const pack = await loadPack(host);
      expect(pack.network.webSockets.some(socket => /:5900\/(?:$|vkvm\/)/i.test(socket.url))).toBe(
        true,
      );
    }
  });

  it('accepts the loaded ES2015 half of the modern Dell differential bundles', async () => {
    const pack = await loadPack('10-10-8-109');
    const viewerWindowIds = reliableKvmWindows(pack.network)
      .map(window => window.captureWindowId)
      .filter((id): id is string => Boolean(id));
    const coverage = adapterSourceCoverage({
      requests: pack.network.httpRequests,
      referenced: pageReferencedScriptsFromEvents(pack.page.events),
      host: pack.probe.basic.host,
      unclassified: true,
      viewerWindowIds,
    });

    expect(coverage.missingReferenced.map(item => item.url).filter(url => /-es5\./i.test(url))).toEqual(
      [],
    );
  });

  it.each(['10-10-8-94', '10-10-8-166'])(
    'recognizes HPE sample %s and treats IRC WebSocket as the direct KVM transport',
    async host => {
      const pack = await loadPack(host);
      const checklist = rebuiltChecklist(pack);
      expect(productHints(pack)[0]?.productFamily).toBe('hpe-ilo-h5');
      expect(checklist.items.find(item => item.id === 'login.chain')?.status).toBe('pass');
      expect(checklist.items.find(item => item.id === 'http.key_api')).toMatchObject({
        status: 'not_applicable',
        evidence: ['hpe-ilo-h5:direct-ws:/wss/ircport'],
      });
      expect(checklist.items.find(item => item.id === 'ws.kvm.established')?.status).toBe('pass');
      expect(checklist.readiness).toBe('PARTIAL');
    },
  );

  it('keeps the existing AMI and Huawei capture families intact', async () => {
    const ami = await loadPack('10-10-8-37');
    const huawei = await loadPack('10-10-8-77');
    expect(ami.manifest.family.primary).toBe('ami-megarac');
    expect(huawei.manifest.family.primary).toBe('huawei-ibmc');
  });

  it('keeps adapter-critical response bodies in the companion HAR files', () => {
    expect(hasHarBody('10-10-8-109', /\/sysmgmt\/2015\/server\/vconsole/i)).toBe(true);
    expect(hasHarBody('10-10-8-101', /\/restgui\/vconsole\/assets\/file\.worker\.js/i, '-kvm')).toBe(
      true,
    );
    expect(hasHarBody('10-10-8-88', /\/ViewerJS\/viewer\/rpviewer\.js/i, '-kvm')).toBe(true);
    expect(hasHarBody('10-10-8-94', /\/js\/irc\.js/i)).toBe(true);
    expect(hasHarBody('10-10-8-166', /\/js\/irc\.js/i)).toBe(true);
    expect(hasHarBody('10-10-8-129', /\/libs\/decode_worker\.js/i, '-kvm')).toBe(true);
    expect(hasHarBody('10-10-8-77', /\/UI\/Rest\/Services\/KVM\/GenerateStartupFile/i, '-kvm')).toBe(
      true,
    );
  });
});

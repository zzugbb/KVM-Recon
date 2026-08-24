import JSZip from 'jszip';

import type { CapturePackDraft } from './types';

export async function buildCapturePackZip(pack: CapturePackDraft): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file('manifest.json', JSON.stringify(pack.manifest, null, 2));
  zip.file('checklist.json', JSON.stringify(pack.checklist, null, 2));
  zip.file('report.md', pack.reportMarkdown);
  for (const artifact of pack.artifacts ?? []) {
    zip.file(artifact.path, artifact.content);
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 6,
    },
  });
}

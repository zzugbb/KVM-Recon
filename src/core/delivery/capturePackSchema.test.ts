import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Ajv, { type ErrorObject } from 'ajv';
import { describe, expect, it } from 'vitest';

import { createSampleCapturePack } from './createSampleCapturePack';

interface JsonSchema {
  $id: string;
  [key: string]: unknown;
}

function jsonLines(content: string) {
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function formatErrors(errors: ErrorObject[] | null | undefined) {
  return (errors || [])
    .map(error => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
    .join('; ');
}

describe('Capture Pack JSON Schema', () => {
  it('validates every structured sample artifact against its declared schema', () => {
    const schemaRoot = join(process.cwd(), 'schema');
    const schemas = readdirSync(schemaRoot)
      .filter(name => name.endsWith('.schema.json'))
      .map(name => JSON.parse(readFileSync(join(schemaRoot, name), 'utf8')) as JsonSchema);
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    for (const schema of schemas) ajv.addSchema(schema);

    const assembled = createSampleCapturePack();
    const artifacts = new Map(
      (assembled.pack.artifacts || [])
        .filter(artifact => typeof artifact.content === 'string')
        .map(artifact => [artifact.path, artifact.content as string]),
    );
    const cases: Array<{ schema: string; path: string; values: unknown[] }> = [
      { schema: 'manifest.schema.json', path: 'manifest.json', values: [assembled.pack.manifest] },
      { schema: 'checklist.schema.json', path: 'checklist.json', values: [assembled.pack.checklist] },
      {
        schema: 'http-request.schema.json',
        path: 'http/requests.jsonl',
        values: jsonLines(artifacts.get('http/requests.jsonl') || ''),
      },
      {
        schema: 'http-adapter-evidence.schema.json',
        path: 'http/adapter-evidence.json',
        values: [JSON.parse(artifacts.get('http/adapter-evidence.json') || 'null')],
      },
      {
        schema: 'network-capture-status.schema.json',
        path: 'http/capture-status.json',
        values: [JSON.parse(artifacts.get('http/capture-status.json') || 'null')],
      },
      {
        schema: 'ws-socket.schema.json',
        path: 'ws/sockets.json',
        values: JSON.parse(artifacts.get('ws/sockets.json') || '[]'),
      },
      {
        schema: 'ws-frame.schema.json',
        path: 'ws/frames.jsonl',
        values: jsonLines(artifacts.get('ws/frames.jsonl') || ''),
      },
      {
        schema: 'page-timeline-event.schema.json',
        path: 'page/timeline.jsonl',
        values: jsonLines(artifacts.get('page/timeline.jsonl') || ''),
      },
      ...[
        ['page-storage.schema.json', 'page/storage.json'],
        ['page-selectors.schema.json', 'page/selectors.json'],
        ['page-screenshots.schema.json', 'page/screenshots.json'],
        ['tls-certificate.schema.json', 'tls/certificate.json'],
        ['probe-bmc-basic.schema.json', 'probe/bmc-basic.json'],
        ['probe-path-evidence.schema.json', 'probe/path-evidence.json'],
        ['probe-path-details.schema.json', 'probe/path-details.json'],
        ['probe-product-hints.schema.json', 'probe/product-hints.json'],
        ['probe-family-signatures.schema.json', 'probe/family-signatures.json'],
        ['probe-redfish.schema.json', 'probe/redfish.json'],
        ['operator-observed.schema.json', 'probe/operator-observed.json'],
      ].map(([schema, path]) => ({
        schema,
        path,
        values: [JSON.parse(artifacts.get(path) || 'null')],
      })),
    ];

    for (const testCase of cases) {
      const schema = schemas.find(candidate => candidate.$id.endsWith(`/${testCase.schema}`));
      const validate = schema ? ajv.getSchema(schema.$id) : undefined;
      expect(validate, `missing validator for ${testCase.schema}`).toBeTypeOf('function');
      for (const value of testCase.values) {
        const valid = validate?.(value);
        expect(valid, `${testCase.path}: ${formatErrors(validate?.errors)}`).toBe(true);
      }
    }
  });
});

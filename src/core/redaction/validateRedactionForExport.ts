import { assertNoSensitivePlaintext } from './redactSensitiveData';

interface ValidateRedactionInput {
  data: unknown;
  sensitiveValues: string[];
  redactedFields: number;
}

interface ValidateRedactionResult {
  status: 'pass' | 'fail';
  redactedFields: number;
  leaks: string[];
  canExportSafePack: boolean;
}

export function validateRedactionForExport(
  input: ValidateRedactionInput,
): ValidateRedactionResult {
  const assertion = assertNoSensitivePlaintext(input.data, input.sensitiveValues);

  return {
    status: assertion.ok ? 'pass' : 'fail',
    redactedFields: input.redactedFields,
    leaks: assertion.leaks,
    canExportSafePack: assertion.ok,
  };
}

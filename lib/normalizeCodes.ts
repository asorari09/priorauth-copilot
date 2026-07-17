/**
 * Normalize extracted procedure/diagnosis codes so rules matching is resilient
 * to common clinician prefixes (CPT, HCPCS, ICD-10, dx, #, colons, whitespace).
 */

const PROCEDURE_LABEL_RE =
  /^(?:CPT|HCPCS|CODE|PROC(?:EDURE)?)\b[\s:#.\-]*/i;

const DIAGNOSIS_LABEL_RE =
  /^(?:ICD[\s\-]?10|ICD|DX|DIAG(?:NOSIS)?)\b[\s:#.\-]*/i;

/** Strip label prefixes / separators; keep alphanumeric core; uppercase. */
export function normalizeProcedureCode(raw: string): string {
  let value = raw.trim();
  value = value.replace(PROCEDURE_LABEL_RE, "").trim();
  value = value.replace(/^[\s:#.\-]+/, "").trim();
  // Keep alphanumeric only (CPT/HCPCS codes have no dots).
  value = value.replace(/[^A-Za-z0-9]/g, "");
  return value.toUpperCase();
}

/** Strip ICD/dx labels; keep alphanumeric + dots; uppercase. */
export function normalizeDiagnosisCode(raw: string): string {
  let value = raw.trim();
  value = value.replace(DIAGNOSIS_LABEL_RE, "").trim();
  value = value.replace(/^[\s:#.\-]+/, "").trim();
  value = value.replace(/[^A-Za-z0-9.]/g, "");
  return value.toUpperCase();
}

export function normalizeExtractionCodes<
  T extends {
    requestedProcedureCode: string;
    diagnosisCodes: string[];
  },
>(extraction: T): T {
  return {
    ...extraction,
    requestedProcedureCode: normalizeProcedureCode(extraction.requestedProcedureCode),
    diagnosisCodes: extraction.diagnosisCodes.map(normalizeDiagnosisCode),
  };
}

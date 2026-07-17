import { describe, expect, it } from "vitest";

import {
  normalizeDiagnosisCode,
  normalizeExtractionCodes,
  normalizeProcedureCode,
} from "../lib/normalizeCodes";

describe("normalizeProcedureCode", () => {
  it("strips CPT / HCPCS / code labels and separators", () => {
    expect(normalizeProcedureCode("CPT 27447")).toBe("27447");
    expect(normalizeProcedureCode("cpt: 27447")).toBe("27447");
    expect(normalizeProcedureCode("HCPCS J1745")).toBe("J1745");
    expect(normalizeProcedureCode("hcpcs:J1745")).toBe("J1745");
    expect(normalizeProcedureCode("code #27447")).toBe("27447");
    expect(normalizeProcedureCode("#27447")).toBe("27447");
    expect(normalizeProcedureCode("procedure 70553")).toBe("70553");
  });

  it("uppercases bare codes and is idempotent", () => {
    expect(normalizeProcedureCode("j1745")).toBe("J1745");
    expect(normalizeProcedureCode("27447")).toBe("27447");
    expect(normalizeProcedureCode(normalizeProcedureCode("CPT 27447"))).toBe("27447");
  });
});

describe("normalizeDiagnosisCode", () => {
  it("strips ICD-10 / dx prefixes while preserving dots", () => {
    expect(normalizeDiagnosisCode("ICD-10 M17.11")).toBe("M17.11");
    expect(normalizeDiagnosisCode("ICD10 K50.90")).toBe("K50.90");
    expect(normalizeDiagnosisCode("dx: M17.11")).toBe("M17.11");
    expect(normalizeDiagnosisCode("Diagnosis K50.90")).toBe("K50.90");
  });

  it("uppercases bare codes and is idempotent", () => {
    expect(normalizeDiagnosisCode("m17.11")).toBe("M17.11");
    expect(normalizeDiagnosisCode(normalizeDiagnosisCode("ICD-10 M17.11"))).toBe(
      "M17.11",
    );
  });
});

describe("normalizeExtractionCodes", () => {
  it("normalizes procedure and diagnosis fields together", () => {
    const result = normalizeExtractionCodes({
      requestedProcedureCode: "CPT 27447",
      diagnosisCodes: ["ICD-10 M17.11", "dx: K50.90"],
    });
    expect(result).toEqual({
      requestedProcedureCode: "27447",
      diagnosisCodes: ["M17.11", "K50.90"],
    });
  });
});

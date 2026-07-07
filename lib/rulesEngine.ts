export type ClinicalExtraction = {
  patientAge: number;
  diagnosisCodes: string[];
  requestedProcedureCode: string;
  priorTreatmentsTried: string[];
  treatmentFailureDocumented: boolean;
  clinicalNotesSummary: string;
  requestedUnits?: number;
  symptomDurationWeeks?: number;
  imagingFindingsPresent?: boolean;
  neurologicDeficitsPresent?: boolean;
};

export type RulesEngineRule = {
  ruleId: string;
  appliesToCpt: string[];
  description: string;
  check: (extraction: ClinicalExtraction) => boolean;
};

export type RulesEngineResult = {
  eligibleByRules: boolean;
  failedCriteria: string[];
  ruleIdsApplied: string[];
};

const J1745_DIAGNOSIS_CODES = ["K50.90", "K51.90", "M05.79"];
const BRAIN_MRI_RED_FLAG_CODES = ["G40.909", "R56.9", "G45.9"];

export const RULES: RulesEngineRule[] = [
  {
    ruleId: "STEP_THERAPY_001",
    appliesToCpt: ["J1745"],
    description: "Requires at least 2 failed conventional therapies",
    check: (e) => e.priorTreatmentsTried.length >= 2 && e.treatmentFailureDocumented,
  },
  {
    ruleId: "AGE_MINIMUM_001",
    appliesToCpt: ["J1745"],
    description: "Patient must be 18 or older",
    check: (e) => e.patientAge >= 18,
  },
  {
    ruleId: "DIAGNOSIS_MATCH_001",
    appliesToCpt: ["J1745"],
    description: "Diagnosis must match an approved inflammatory condition",
    check: (e) =>
      e.diagnosisCodes.some((code) => J1745_DIAGNOSIS_CODES.includes(code.toUpperCase())),
  },
  {
    ruleId: "QUANTITY_LIMIT_001",
    appliesToCpt: ["J1745"],
    description: "Requested units may not exceed 8 per authorization period",
    check: (e) => {
      if (e.requestedUnits == null) {
        return false;
      }

      return e.requestedUnits > 0 && e.requestedUnits <= 8;
    },
  },
  {
    ruleId: "AGE_MINIMUM_002",
    appliesToCpt: ["27447"],
    description: "Patient must be 50 or older for synthetic joint-replacement criteria",
    check: (e) => e.patientAge >= 50,
  },
  {
    ruleId: "CONSERVATIVE_CARE_001",
    appliesToCpt: ["27447"],
    description:
      "Requires >= 12 weeks of failed conservative care including PT and NSAID use",
    check: (e) =>
      (e.symptomDurationWeeks ?? 0) >= 12 &&
      e.treatmentFailureDocumented &&
      e.priorTreatmentsTried.some((t) => t.toLowerCase() === "physical therapy") &&
      e.priorTreatmentsTried.some((t) => t.toLowerCase() === "nsaid"),
  },
  {
    ruleId: "RED_FLAG_001",
    appliesToCpt: ["70553"],
    description: "Requires neurologic deficit or qualifying red-flag diagnosis code",
    check: (e) =>
      e.neurologicDeficitsPresent === true ||
      e.diagnosisCodes.some((code) => BRAIN_MRI_RED_FLAG_CODES.includes(code.toUpperCase())),
  },
  {
    ruleId: "PRIOR_IMAGING_001",
    appliesToCpt: ["70553"],
    description: "Prior non-advanced imaging or focal findings must be documented",
    check: (e) => e.imagingFindingsPresent === true,
  },
];

export function runRulesEngine(extraction: ClinicalExtraction): RulesEngineResult {
  const applicableRules = RULES.filter((rule) =>
    rule.appliesToCpt.includes(extraction.requestedProcedureCode),
  );

  if (applicableRules.length === 0) {
    return {
      eligibleByRules: false,
      failedCriteria: ["NO_APPLICABLE_RULES"],
      ruleIdsApplied: [],
    };
  }

  const failedCriteria: string[] = [];
  const ruleIdsApplied: string[] = [];

  for (const rule of applicableRules) {
    ruleIdsApplied.push(rule.ruleId);

    if (!rule.check(extraction)) {
      failedCriteria.push(`${rule.ruleId}: ${rule.description}`);
    }
  }

  return {
    eligibleByRules: failedCriteria.length === 0,
    failedCriteria,
    ruleIdsApplied,
  };
}

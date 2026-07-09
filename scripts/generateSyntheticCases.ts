import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ClinicalExtractionSchema, type ClinicalExtraction } from "../lib/schemas";

type ExpectedOutcome = "likely_approve" | "likely_deny" | "insufficient_info";

type GoldenCase = {
  id: string;
  note: string;
  expectedOutcome: ExpectedOutcome;
  expectedExtraction: ClinicalExtraction;
};

type CaseSeed = {
  id: string;
  patientLabel: string;
  requestedProcedureCode: "J1745" | "27447" | "70553";
  diagnosisCodes: string[];
  patientAge: number;
  priorTreatmentsTried: string[];
  treatmentFailureDocumented: boolean;
  expectedOutcome: ExpectedOutcome;
  clinicalNotesSummary: string;
  requestedUnits?: number;
  symptomDurationWeeks?: number;
  imagingFindingsPresent?: boolean;
  neurologicDeficitsPresent?: boolean;
  specialContext?: string;
};

const seeds: CaseSeed[] = [
  {
    id: "CASE-001",
    patientLabel: "A",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["K50.90"],
    patientAge: 29,
    priorTreatmentsTried: ["mesalamine", "azathioprine"],
    treatmentFailureDocumented: true,
    requestedUnits: 6,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Adult Crohn disease with two failed therapies and dose within limit.",
  },
  {
    id: "CASE-002",
    patientLabel: "B",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["K51.90"],
    patientAge: 41,
    priorTreatmentsTried: ["sulfasalazine", "methotrexate"],
    treatmentFailureDocumented: true,
    requestedUnits: 8,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Ulcerative colitis with documented step therapy failure and compliant quantity.",
  },
  {
    id: "CASE-003",
    patientLabel: "C",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["M05.79"],
    patientAge: 56,
    priorTreatmentsTried: ["hydroxychloroquine", "leflunomide", "methotrexate"],
    treatmentFailureDocumented: true,
    requestedUnits: 4,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Seropositive rheumatoid arthritis refractory to three conventional agents.",
  },
  {
    id: "CASE-004",
    patientLabel: "D",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["K50.90"],
    patientAge: 17,
    priorTreatmentsTried: ["mesalamine", "azathioprine"],
    treatmentFailureDocumented: true,
    requestedUnits: 5,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Adolescent Crohn patient meets therapy history but fails adult age threshold.",
  },
  {
    id: "CASE-005",
    patientLabel: "E",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["K50.90"],
    patientAge: 38,
    priorTreatmentsTried: ["mesalamine"],
    treatmentFailureDocumented: true,
    requestedUnits: 6,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Only one conventional therapy trialed before biologic request.",
  },
  {
    id: "CASE-006",
    patientLabel: "F",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["M54.5"],
    patientAge: 44,
    priorTreatmentsTried: ["methotrexate", "sulfasalazine"],
    treatmentFailureDocumented: true,
    requestedUnits: 6,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Biologic requested for non-covered diagnosis code.",
  },
  {
    id: "CASE-007",
    patientLabel: "G",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["K51.90"],
    patientAge: 34,
    priorTreatmentsTried: ["methotrexate", "sulfasalazine"],
    treatmentFailureDocumented: true,
    requestedUnits: 7,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Ulcerative colitis with step therapy complete and quantity inside limit.",
  },
  {
    id: "CASE-008",
    patientLabel: "H",
    requestedProcedureCode: "J1745",
    diagnosisCodes: ["K50.90"],
    patientAge: 48,
    priorTreatmentsTried: ["azathioprine", "mesalamine"],
    treatmentFailureDocumented: true,
    expectedOutcome: "insufficient_info",
    clinicalNotesSummary: "Crohn disease with step therapy met but infusion units not documented.",
    specialContext: "Outside infusion-center paperwork did not list the exact number of units requested.",
  },
  {
    id: "CASE-009",
    patientLabel: "I",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.11"],
    patientAge: 68,
    priorTreatmentsTried: ["physical therapy", "nsaid", "weight loss"],
    treatmentFailureDocumented: true,
    symptomDurationWeeks: 20,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Advanced unilateral knee OA with prolonged conservative care failure.",
  },
  {
    id: "CASE-010",
    patientLabel: "J",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.12"],
    patientAge: 72,
    priorTreatmentsTried: ["physical therapy", "nsaid", "intra-articular injection"],
    treatmentFailureDocumented: true,
    symptomDurationWeeks: 52,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Long-standing left knee OA despite PT and NSAID regimen.",
  },
  {
    id: "CASE-011",
    patientLabel: "K",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.0"],
    patientAge: 59,
    priorTreatmentsTried: ["physical therapy", "nsaid", "bracing"],
    treatmentFailureDocumented: true,
    symptomDurationWeeks: 14,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Bilateral knee OA with documented conservative failure over 14 weeks.",
  },
  {
    id: "CASE-012",
    patientLabel: "L",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.11"],
    patientAge: 47,
    priorTreatmentsTried: ["physical therapy", "nsaid"],
    treatmentFailureDocumented: true,
    symptomDurationWeeks: 18,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Conservative criteria met but age is below threshold.",
  },
  {
    id: "CASE-013",
    patientLabel: "M",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.12"],
    patientAge: 63,
    priorTreatmentsTried: ["acetaminophen", "home exercise"],
    treatmentFailureDocumented: true,
    symptomDurationWeeks: 30,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "No PT and no NSAID despite prolonged knee symptoms.",
  },
  {
    id: "CASE-014",
    patientLabel: "N",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.11"],
    patientAge: 66,
    priorTreatmentsTried: ["physical therapy", "nsaid"],
    treatmentFailureDocumented: false,
    symptomDurationWeeks: 24,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Therapies listed but no documented failure statement.",
  },
  {
    id: "CASE-015",
    patientLabel: "O",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.0"],
    patientAge: 61,
    priorTreatmentsTried: ["physical therapy", "nsaid"],
    treatmentFailureDocumented: true,
    symptomDurationWeeks: 8,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Duration of conservative care is below 12-week requirement.",
  },
  {
    id: "CASE-016",
    patientLabel: "P",
    requestedProcedureCode: "27447",
    diagnosisCodes: ["M17.12"],
    patientAge: 70,
    priorTreatmentsTried: ["physical therapy", "nsaid", "cane use"],
    treatmentFailureDocumented: true,
    expectedOutcome: "insufficient_info",
    clinicalNotesSummary: "OA severity noted, but exact conservative-care duration not documented.",
    specialContext:
      "The referring note repeatedly says symptoms persisted 'for many months' without listing a specific week count.",
  },
  {
    id: "CASE-017",
    patientLabel: "Q",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["G40.909"],
    patientAge: 25,
    priorTreatmentsTried: ["levetiracetam"],
    treatmentFailureDocumented: true,
    imagingFindingsPresent: true,
    neurologicDeficitsPresent: false,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Seizure disorder code present with prior imaging abnormalities documented.",
  },
  {
    id: "CASE-018",
    patientLabel: "R",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["R56.9"],
    patientAge: 43,
    priorTreatmentsTried: ["acetaminophen"],
    treatmentFailureDocumented: false,
    imagingFindingsPresent: true,
    neurologicDeficitsPresent: false,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "Red-flag seizure presentation with documented focal imaging concern.",
  },
  {
    id: "CASE-019",
    patientLabel: "S",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["R51.9"],
    patientAge: 58,
    priorTreatmentsTried: ["topiramate"],
    treatmentFailureDocumented: true,
    imagingFindingsPresent: true,
    neurologicDeficitsPresent: true,
    expectedOutcome: "likely_approve",
    clinicalNotesSummary: "New focal neurologic deficit and concerning prior imaging findings.",
  },
  {
    id: "CASE-020",
    patientLabel: "T",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["R51.9"],
    patientAge: 39,
    priorTreatmentsTried: ["sumatriptan"],
    treatmentFailureDocumented: false,
    imagingFindingsPresent: true,
    neurologicDeficitsPresent: false,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "No neurologic deficits and no qualifying red-flag diagnosis code.",
  },
  {
    id: "CASE-021",
    patientLabel: "U",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["G45.9"],
    patientAge: 66,
    priorTreatmentsTried: ["aspirin"],
    treatmentFailureDocumented: false,
    imagingFindingsPresent: false,
    neurologicDeficitsPresent: false,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Red-flag code present but no prior imaging findings documented.",
  },
  {
    id: "CASE-022",
    patientLabel: "V",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["R42"],
    patientAge: 51,
    priorTreatmentsTried: ["meclizine"],
    treatmentFailureDocumented: false,
    imagingFindingsPresent: false,
    neurologicDeficitsPresent: false,
    expectedOutcome: "likely_deny",
    clinicalNotesSummary: "Neither red-flag diagnosis nor focal neurologic deficits are present.",
  },
  {
    id: "CASE-023",
    patientLabel: "W",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["R56.9"],
    patientAge: 33,
    priorTreatmentsTried: ["levetiracetam"],
    treatmentFailureDocumented: true,
    neurologicDeficitsPresent: false,
    expectedOutcome: "insufficient_info",
    clinicalNotesSummary: "Seizure red flag documented, but prior imaging documentation is missing.",
    specialContext:
      "Outside emergency records mention 'prior scans unavailable at this visit' and do not confirm focal findings.",
  },
  {
    id: "CASE-024",
    patientLabel: "X",
    requestedProcedureCode: "70553",
    diagnosisCodes: ["R51.9"],
    patientAge: 46,
    priorTreatmentsTried: ["acetaminophen", "propranolol"],
    treatmentFailureDocumented: true,
    imagingFindingsPresent: true,
    expectedOutcome: "insufficient_info",
    clinicalNotesSummary: "Headache workup with imaging concern documented but neurologic exam finding unspecified.",
    specialContext:
      "The neurologic exam is described as 'concerning changes per family report' without explicitly documenting a focal deficit.",
  },
];

function sentenceList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function buildNote(seed: CaseSeed): string {
  const codeString = seed.diagnosisCodes.map((d) => `(${d})`).join(", ");
  const p1 =
    `SYNTHETIC CASE ${seed.id}: Prior authorization intake for patient ${seed.patientLabel}. ` +
    `The ordering clinician documented diagnosis codes ${codeString} and requested procedure ${seed.requestedProcedureCode}. ` +
    `The patient is ${seed.patientAge} years old and presented for coverage review in a routine outpatient workflow.`;

  const p2 =
    `Chart review states prior management included ${sentenceList(seed.priorTreatmentsTried)}. ` +
    `Treatment failure was documented as ${seed.treatmentFailureDocumented ? "true" : "false"} in the assessment narrative. ` +
    `The progress note summary reads: "${seed.clinicalNotesSummary}"`;

  const details: string[] = [];
  if (seed.requestedUnits !== undefined) {
    details.push(`Requested infusion quantity is ${seed.requestedUnits} units for this authorization period.`);
  }
  if (seed.symptomDurationWeeks !== undefined) {
    details.push(
      `Symptoms have persisted for ${seed.symptomDurationWeeks} weeks despite conservative management.`,
    );
  }
  if (seed.neurologicDeficitsPresent !== undefined) {
    details.push(
      `Neurologic deficits are documented as ${seed.neurologicDeficitsPresent ? "present" : "absent"} in the exam.`,
    );
  }
  if (seed.imagingFindingsPresent !== undefined) {
    details.push(
      `Prior imaging or focal findings are documented as ${seed.imagingFindingsPresent ? "present" : "not present"}.`,
    );
  }
  if (seed.specialContext) {
    details.push(seed.specialContext);
  }

  const p3 =
    details.length > 0
      ? details.join(" ")
      : "The referring team requested expedited review and included no additional structured qualifiers.";

  return `${p1}\n\n${p2}\n\n${p3}`;
}

function toExpectedExtraction(seed: CaseSeed): ClinicalExtraction {
  return {
    patientAge: seed.patientAge,
    diagnosisCodes: seed.diagnosisCodes,
    requestedProcedureCode: seed.requestedProcedureCode,
    priorTreatmentsTried: seed.priorTreatmentsTried,
    treatmentFailureDocumented: seed.treatmentFailureDocumented,
    clinicalNotesSummary: seed.clinicalNotesSummary,
    ...(seed.requestedUnits !== undefined ? { requestedUnits: seed.requestedUnits } : {}),
    ...(seed.symptomDurationWeeks !== undefined
      ? { symptomDurationWeeks: seed.symptomDurationWeeks }
      : {}),
    ...(seed.imagingFindingsPresent !== undefined
      ? { imagingFindingsPresent: seed.imagingFindingsPresent }
      : {}),
    ...(seed.neurologicDeficitsPresent !== undefined
      ? { neurologicDeficitsPresent: seed.neurologicDeficitsPresent }
      : {}),
  };
}

function validate(cases: GoldenCase[]): void {
  if (cases.length !== 24) {
    throw new Error(`Expected 24 cases, found ${cases.length}`);
  }

  const outcomes = cases.reduce<Record<ExpectedOutcome, number>>(
    (acc, item) => {
      acc[item.expectedOutcome] += 1;
      return acc;
    },
    { likely_approve: 0, likely_deny: 0, insufficient_info: 0 },
  );

  if (
    outcomes.likely_approve !== 10 ||
    outcomes.likely_deny !== 10 ||
    outcomes.insufficient_info !== 4
  ) {
    throw new Error(`Unexpected outcome distribution: ${JSON.stringify(outcomes)}`);
  }

  const cptCounts = cases.reduce<Record<string, number>>((acc, item) => {
    const cpt = item.expectedExtraction.requestedProcedureCode;
    acc[cpt] = (acc[cpt] ?? 0) + 1;
    return acc;
  }, {});

  for (const cpt of ["J1745", "27447", "70553"]) {
    if (cptCounts[cpt] !== 8) {
      throw new Error(`Expected 8 cases for ${cpt}, found ${cptCounts[cpt] ?? 0}`);
    }
  }

  for (const item of cases) {
    ClinicalExtractionSchema.parse(item.expectedExtraction);
    if (!item.note.includes("SYNTHETIC")) {
      throw new Error(`${item.id} is missing SYNTHETIC header`);
    }
    const paragraphs = item.note.split("\n\n");
    if (paragraphs.length < 3 || paragraphs.length > 5) {
      throw new Error(`${item.id} must have header + 2-4 paragraphs`);
    }
  }
}

function main() {
  const cases: GoldenCase[] = seeds.map((seed) => ({
    id: seed.id,
    note: buildNote(seed),
    expectedOutcome: seed.expectedOutcome,
    expectedExtraction: toExpectedExtraction(seed),
  }));

  validate(cases);

  const outputDir = join(process.cwd(), "data");
  const outputPath = join(outputDir, "goldenCases.json");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(cases, null, 2)}\n`, "utf8");
  console.log(`Wrote ${cases.length} cases to data/goldenCases.json`);
}

main();

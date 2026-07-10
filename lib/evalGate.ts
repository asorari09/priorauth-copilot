export type EvalSummaryGate = {
  decisionAccuracy: number;
  falseApproveRate: number;
  citationValidityRate: number;
};

export function evalSummaryPassesGate(summary: EvalSummaryGate): boolean {
  return (
    summary.decisionAccuracy === 100 &&
    summary.falseApproveRate === 0 &&
    summary.citationValidityRate === 100
  );
}

export function formatEvalGateFailure(summary: EvalSummaryGate): string {
  const failures: string[] = [];
  if (summary.decisionAccuracy !== 100) {
    failures.push(`decisionAccuracy=${summary.decisionAccuracy} (required 100)`);
  }
  if (summary.falseApproveRate !== 0) {
    failures.push(`falseApproveRate=${summary.falseApproveRate} (required 0)`);
  }
  if (summary.citationValidityRate !== 100) {
    failures.push(`citationValidityRate=${summary.citationValidityRate} (required 100)`);
  }
  return failures.join("; ");
}

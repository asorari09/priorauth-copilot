import { describe, expect, it } from "vitest";

import {
  claimedTreatmentsAreAllowed,
  draftClaimsForbiddenTherapyTried,
} from "../lib/graph/appealValidation";

describe("claimedTreatmentsAreAllowed", () => {
  it("accepts treatments present in priorTreatmentsTried (casefolded)", () => {
    expect(
      claimedTreatmentsAreAllowed(["Mesalamine"], ["mesalamine", "azathioprine"]),
    ).toEqual({ ok: true });
  });

  it("rejects treatments not in priorTreatmentsTried", () => {
    expect(
      claimedTreatmentsAreAllowed(
        ["mesalamine", "budesonide"],
        ["mesalamine"],
      ),
    ).toEqual({ ok: false, disallowed: ["budesonide"] });
  });
});

describe("draftClaimsForbiddenTherapyTried", () => {
  it("flags fabricated try/fail claims for declined therapies", () => {
    expect(
      draftClaimsForbiddenTherapyTried(
        "Patient attempted budesonide and failed step therapy.",
        ["budesonide"],
      ),
    ).toBe("budesonide");
  });

  it("allows honest declined wording without try/fail verbs", () => {
    expect(
      draftClaimsForbiddenTherapyTried(
        "Budesonide was discussed but declined and never started. We request guidance.",
        ["budesonide"],
      ),
    ).toBeNull();
  });
});

import { describe, expect, test } from "vitest";

import { GreenContract } from "../../src/runtime";

describe("runtime green contract", () => {
  test("given_matching_level_when_evaluating_contract_then_it_is_satisfied", async () => {
    expect(new GreenContract(3).isSatisfiedBy(3)).toBe(true);
  });

  test("given_higher_level_when_checking_requirement_then_it_still_satisfies_contract", async () => {
    expect(new GreenContract(3).isSatisfiedBy(4)).toBe(true);
  });

  test("given_lower_level_when_evaluating_contract_then_it_is_unsatisfied", async () => {
    expect(new GreenContract(3).isSatisfiedBy(1)).toBe(false);
  });

  test("given_no_green_level_when_evaluating_contract_then_contract_is_unsatisfied", async () => {
    expect(new GreenContract(3).isSatisfiedBy(undefined)).toBe(false);
  });
});

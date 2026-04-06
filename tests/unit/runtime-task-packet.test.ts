import { describe, expect, test } from "vitest";

import {
  TaskPacketValidationError,
  validatePacket
} from "../../src/runtime/task-packet.js";

describe("runtime task packet", () => {
  test("ports task packet serialization and helper behavior", async () => {
    const packet = {
      objective: "Implement typed task packet format",
      scope: "runtime/task system",
      repo: "clench-parity",
      branchPolicy: "origin/main only",
      acceptanceTests: ["cargo build --workspace", "cargo test --workspace"],
      commitPolicy: "single verified commit",
      reportingContract: "print build result, test result, commit sha",
      escalationPolicy: "stop only on destructive ambiguity"
    };

    const validated = validatePacket(packet);
    expect(validated.packet()).toEqual(packet);
    expect(validated.intoInner()).toEqual(packet);
    expect(JSON.parse(JSON.stringify(packet))).toEqual(packet);

    expect(() =>
      validatePacket({
        objective: " ",
        scope: "",
        repo: "",
        branchPolicy: "\t",
        acceptanceTests: ["ok", " "],
        commitPolicy: "",
        reportingContract: "",
        escalationPolicy: ""
      })
    ).toThrow(TaskPacketValidationError);

    try {
      validatePacket({
        objective: " ",
        scope: "",
        repo: "",
        branchPolicy: "\t",
        acceptanceTests: ["ok", " "],
        commitPolicy: "",
        reportingContract: "",
        escalationPolicy: ""
      });
    } catch (error) {
      const validation = error as TaskPacketValidationError;
      expect(validation.errors().length).toBeGreaterThanOrEqual(7);
      expect(validation.errors()).toContain("objective must not be empty");
      expect(validation.errors()).toContain("scope must not be empty");
      expect(validation.errors()).toContain("repo must not be empty");
      expect(validation.errors()).toContain("acceptance_tests contains an empty value at index 1");
    }
  });
});

import { describe, expect, test } from "vitest";

import * as runtime from "../../src/runtime";

describe("runtime lib", () => {
  test("ports runtime crate root export behavior", async () => {
    expect(typeof runtime.ConversationRuntime).toBe("function");
    expect(typeof runtime.PermissionPolicy).toBe("function");
    expect(typeof runtime.executeBash).toBe("function");
    expect(typeof runtime.summaryLinesForModel).toBe("function");
    expect(typeof runtime.PolicyEngine).toBe("function");
    expect(typeof runtime.resolveConfigLayers).toBe("function");
    expect(typeof runtime.runHooks).toBe("function");
  });
});

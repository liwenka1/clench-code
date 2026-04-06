import { describe, expect, test } from "vitest";

import { LspRegistry, lspActionFromString } from "../../src/runtime/lsp-client.js";

describe("runtime lsp client", () => {
  test("ports LSP client behavior", async () => {
    const registry = new LspRegistry();
    registry.register("rust", "connected", "/workspace", ["hover", "completion"]);
    registry.register("typescript", "disconnected", undefined, []);
    registry.register("javascript", "connected", undefined, ["completion"]);
    registry.register("python", "connected", undefined, []);
    registry.register("cpp", "connected", undefined, ["completion"]);
    registry.register("ruby", "connected", undefined, []);
    registry.register("lua", "connected", undefined, []);

    expect(registry.get("rust")?.language).toBe("rust");
    expect(registry.get("rust")?.capabilities).toEqual(["hover", "completion"]);
    expect(registry.findServerForPath("src/main.rs")?.language).toBe("rust");
    expect(registry.findServerForPath("src/index.ts")?.language).toBe("typescript");
    expect(registry.findServerForPath("components/App.tsx")?.language).toBe("typescript");
    expect(registry.findServerForPath("components/App.jsx")?.language).toBe("javascript");
    expect(registry.findServerForPath("script.py")?.language).toBe("python");
    expect(registry.findServerForPath("data.csv")).toBeUndefined();
    expect(registry.findServerForPath("lib.rs")?.language).toBe("rust");
    expect(registry.findServerForPath("main.cpp")?.language).toBe("cpp");
    expect(registry.findServerForPath("mod.rb")?.language).toBe("ruby");
    expect(registry.findServerForPath("init.lua")?.language).toBe("lua");

    registry.addDiagnostics("rust", [
      {
        path: "src/lib.rs",
        line: 1,
        character: 0,
        severity: "warning",
        message: "unused import",
        source: "rust-analyzer"
      }
    ]);
    registry.addDiagnostics("python", [
      {
        path: "script.py",
        line: 2,
        character: 4,
        severity: "error",
        message: "undefined name",
        source: "pyright"
      }
    ]);

    expect(registry.getDiagnostics("src/lib.rs")).toHaveLength(1);
    expect(registry.dispatch("diagnostics", "src/lib.rs").count).toBe(1);
    expect(registry.dispatch("diagnostics").count).toBe(2);

    const hover = registry.dispatch("hover", "src/main.rs", 10, 5, "ident");
    expect(hover.action).toBe("hover");
    expect(hover.language).toBe("rust");
    expect(hover.query).toBe("ident");

    const completion = registry.dispatch("completions", "src/main.rs", 3, 10);
    expect(completion.action).toBe("completion");

    const symbols = registry.dispatch("document_symbols", "src/main.rs", 0, 0);
    expect(symbols.action).toBe("symbols");
    const fmt = registry.dispatch("formatting", "src/main.rs", 1, 2);
    expect(fmt.action).toBe("format");
    const refs = registry.dispatch("find_references", "src/main.rs", 4, 1);
    expect(refs.action).toBe("references");
    const def = registry.dispatch("goto_definition", "src/main.rs", 2, 2);
    expect(def.action).toBe("definition");

    expect(() => registry.dispatch("hover")).toThrow("path is required");
    expect(() => registry.dispatch("hover", "notes.md", 1, 0)).toThrow("no LSP server available");
    expect(() => registry.dispatch("hover", "src/index.ts", 3, 2)).toThrow("not connected");
    expect(() => registry.dispatch("unknown_action", "file.rs")).toThrow("unknown LSP action");

    registry.clearDiagnostics("rust");
    expect(registry.getDiagnostics("src/lib.rs")).toHaveLength(0);
    expect(() => registry.addDiagnostics("missing", [])).toThrow("LSP server not found for language: missing");
    expect(() => registry.clearDiagnostics("missing")).toThrow("LSP server not found for language: missing");

    expect(lspActionFromString("goto_definition")).toBe("definition");
    expect(lspActionFromString("find_references")).toBe("references");
    expect(lspActionFromString("document_symbols")).toBe("symbols");
    expect(lspActionFromString("formatting")).toBe("format");
    expect(lspActionFromString("completions")).toBe("completion");
    expect(lspActionFromString("unknown")).toBeUndefined();

    expect(registry.listServers()).toHaveLength(7);
    expect(registry.len()).toBe(7);
    expect(registry.isEmpty()).toBe(false);

    expect(registry.disconnect("rust")?.language).toBe("rust");
    expect(registry.disconnect("missing")).toBeUndefined();
    expect(registry.len()).toBe(6);
  });

  test("empty registry and diagnostics isolation", async () => {
    const empty = new LspRegistry();
    expect(empty.listServers()).toEqual([]);
    expect(empty.isEmpty()).toBe(true);
    expect(empty.get("any")).toBeUndefined();

    const r = new LspRegistry();
    r.register("go", "connected", "/p", ["diagnostics"]);
    r.addDiagnostics("go", [{ path: "a.go", line: 0, character: 0, severity: "error", message: "e" }]);
    r.addDiagnostics("go", [{ path: "b.go", line: 1, character: 1, severity: "hint", message: "h" }]);
    expect(r.getDiagnostics("a.go")).toHaveLength(1);
    expect(r.dispatch("diagnostics").count).toBe(2);
    r.clearDiagnostics("go");
    expect(r.dispatch("diagnostics").count).toBe(0);
  });
});

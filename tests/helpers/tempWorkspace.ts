import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempWorkspace {
  root: string;
  cleanup: () => Promise<void>;
}

export async function createTempWorkspace(prefix = "clench-test-"): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), prefix));

  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

export interface BranchLockIntent {
  laneId: string;
  branch: string;
  worktree?: string;
  modules: string[];
}

export interface BranchLockCollision {
  branch: string;
  module: string;
  laneIds: string[];
}

export function detectBranchLockCollisions(intents: BranchLockIntent[]): BranchLockCollision[] {
  const collisions: BranchLockCollision[] = [];

  for (let index = 0; index < intents.length; index += 1) {
    const left = intents[index]!;
    for (const right of intents.slice(index + 1)) {
      if (left.branch !== right.branch) {
        continue;
      }
      for (const module of overlappingModules(left.modules, right.modules)) {
        collisions.push({
          branch: left.branch,
          module,
          laneIds: [left.laneId, right.laneId]
        });
      }
    }
  }

  return collisions
    .sort((a, b) => {
      return (
        a.branch.localeCompare(b.branch) ||
        a.module.localeCompare(b.module) ||
        a.laneIds.join("\0").localeCompare(b.laneIds.join("\0"))
      );
    })
    .filter((collision, index, all) => {
      if (index === 0) {
        return true;
      }
      const previous = all[index - 1]!;
      return !(
        previous.branch === collision.branch &&
        previous.module === collision.module &&
        previous.laneIds.join("\0") === collision.laneIds.join("\0")
      );
    });
}

function overlappingModules(left: string[], right: string[]): string[] {
  const overlaps = new Set<string>();
  for (const leftModule of left) {
    for (const rightModule of right) {
      if (modulesOverlap(leftModule, rightModule)) {
        overlaps.add(sharedScope(leftModule, rightModule));
      }
    }
  }
  return [...overlaps].sort();
}

function modulesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function sharedScope(left: string, right: string): string {
  if (left === right || left.startsWith(`${right}/`)) {
    return right;
  }
  return left;
}

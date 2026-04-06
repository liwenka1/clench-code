import fs from "node:fs";
import path from "node:path";

export interface ReadFilePayload {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

export interface WriteFilePayload {
  type: "create" | "update";
  filePath: string;
  content: string;
  originalFile?: string;
}

export interface EditFilePayload {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  replaceAll: boolean;
}

export interface GlobSearchPayload {
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}

export interface GrepSearchPayload {
  numFiles: number;
  filenames: string[];
  content?: string;
  numMatches?: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function readFileText(filePath: string, offset = 0, limit?: number): ReadFilePayload {
  const absolutePath = normalizePath(filePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  rejectOversized(content);
  rejectBinary(content);
  const lines = content.split("\n");
  const start = Math.min(offset, lines.length);
  const end = typeof limit === "number" ? Math.min(start + limit, lines.length) : lines.length;
  return {
    filePath: absolutePath,
    content: lines.slice(start, end).join("\n"),
    numLines: end - start,
    startLine: start + 1,
    totalLines: lines.length
  };
}

export function writeFileText(filePath: string, content: string): WriteFilePayload {
  rejectOversized(content);
  const absolutePath = normalizePathAllowMissing(filePath);
  const originalFile = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : undefined;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
  return {
    type: originalFile === undefined ? "create" : "update",
    filePath: absolutePath,
    content,
    originalFile
  };
}

export function editFileText(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): EditFilePayload {
  const absolutePath = normalizePath(filePath);
  const originalFile = fs.readFileSync(absolutePath, "utf8");
  if (!originalFile.includes(oldString)) {
    throw new Error("old_string not found in file");
  }
  const updated = replaceAll ? originalFile.split(oldString).join(newString) : originalFile.replace(oldString, newString);
  fs.writeFileSync(absolutePath, updated, "utf8");
  return {
    filePath: absolutePath,
    oldString,
    newString,
    originalFile,
    replaceAll
  };
}

export function globSearch(pattern: string, searchRoot = process.cwd()): GlobSearchPayload {
  const files = collectFiles(searchRoot).filter((file) => wildcardToRegExp(pattern).test(relativeToRoot(file, searchRoot)));
  return {
    numFiles: Math.min(files.length, 100),
    filenames: files.slice(0, 100),
    truncated: files.length > 100
  };
}

export function grepSearch(
  pattern: string,
  searchRoot = process.cwd(),
  outputMode: "content" | "count" = "content"
): GrepSearchPayload {
  const regex = new RegExp(pattern, "g");
  const filenames: string[] = [];
  const contentMatches: string[] = [];
  let numMatches = 0;

  for (const file of collectFiles(searchRoot)) {
    const content = fs.readFileSync(file, "utf8");
    const matches = [...content.matchAll(regex)];
    if (matches.length === 0) {
      continue;
    }
    filenames.push(file);
    numMatches += matches.length;
    if (outputMode === "content") {
      contentMatches.push(...content.split("\n").filter((line) => new RegExp(pattern).test(line)).map((line) => `${file}:${line}`));
    }
  }

  return {
    numFiles: filenames.length,
    filenames,
    content: outputMode === "content" ? contentMatches.join("\n") : undefined,
    numMatches: outputMode === "count" ? numMatches : undefined
  };
}

export function readFileInWorkspace(
  filePath: string,
  workspaceRoot: string,
  offset = 0,
  limit?: number
): ReadFilePayload {
  assertWorkspaceBoundary(normalizePath(filePath), normalizePath(workspaceRoot));
  return readFileText(filePath, offset, limit);
}

export function isSymlinkEscape(targetPath: string, workspaceRoot: string): boolean {
  const stats = fs.lstatSync(targetPath);
  if (!stats.isSymbolicLink()) {
    return false;
  }
  const resolved = fs.realpathSync(targetPath);
  return !resolved.startsWith(normalizePath(workspaceRoot));
}

function collectFiles(searchRoot: string): string[] {
  const results: string[] = [];
  const root = normalizePath(searchRoot);
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else {
        results.push(next);
      }
    }
  };
  walk(root);
  return results;
}

function wildcardToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${normalized}$`);
}

function relativeToRoot(filePath: string, root: string): string {
  return path.relative(normalizePath(root), filePath).replace(/\\/g, "/");
}

function normalizePath(filePath: string): string {
  return fs.realpathSync(filePath);
}

function normalizePathAllowMissing(filePath: string): string {
  if (fs.existsSync(filePath)) {
    return fs.realpathSync(filePath);
  }
  return path.resolve(filePath);
}

function rejectBinary(content: string): void {
  if (content.includes("\u0000")) {
    throw new Error("file appears to be binary");
  }
}

function rejectOversized(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE) {
    throw new Error("content is too large");
  }
}

function assertWorkspaceBoundary(resolvedPath: string, workspaceRoot: string): void {
  if (!resolvedPath.startsWith(workspaceRoot)) {
    throw new Error(`path ${resolvedPath} escapes workspace boundary ${workspaceRoot}`);
  }
}

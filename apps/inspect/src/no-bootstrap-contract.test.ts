import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Bootstrap was removed in favor of the `--inspect-*` tokens and the
 * `data-theme` attribute (tokens.css / reboot.css / components.css /
 * apply-theme.ts). A single stray `var(--bs-...)` or `data-bs-theme`
 * resolves to nothing at runtime and regresses silently, so fail fast here.
 */

const REPO_ROOT = resolve(__dirname, "../../..");
// Source only: design/ and docs/ (and *.md generally) may mention --bs- when
// discussing the migration itself; "lib" matches the vite library outDir.
const SCANNED_ROOTS = ["apps", "packages", "tooling"];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".css", ".html"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "lib", "coverage"]);

const collectFiles = (dir: string, out: string[]): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name))
        collectFiles(join(dir, entry.name), out);
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

const sourceFiles = SCANNED_ROOTS.flatMap((root) =>
  collectFiles(join(REPO_ROOT, root), [])
);

const offenders = (pattern: RegExp): string[] =>
  sourceFiles
    .filter((file) => !file.endsWith("no-bootstrap-contract.test.ts"))
    .flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      return lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => pattern.test(line))
        .map(({ line, i }) => `${file}:${i + 1}: ${line.trim()}`);
    });

describe("bootstrap removal contract", () => {
  it("finds a sane number of source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it("has no --bs- CSS variable references", () => {
    expect(offenders(/--bs-/)).toEqual([]);
  });

  it("has no data-bs-theme attribute usage", () => {
    expect(offenders(/data-bs-theme/)).toEqual([]);
  });

  it("has no bootstrap package imports (bootstrap-icons is allowed)", () => {
    expect(
      offenders(/from\s+["']bootstrap["']|import\s+["']bootstrap\//)
    ).toEqual([]);
  });
});

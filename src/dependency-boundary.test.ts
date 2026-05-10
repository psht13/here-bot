import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("./", import.meta.url));

interface BoundaryRule {
  layerName: string;
  directory: string;
  bannedPackages: string[];
}

const boundaryRules: BoundaryRule[] = [
  {
    layerName: "domain",
    directory: "domain",
    bannedPackages: ["grammy", "dotenv", "zod"],
  },
  {
    layerName: "application",
    directory: "application",
    bannedPackages: ["grammy", "dotenv"],
  },
];

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectTypeScriptFiles(entryPath);
      }

      if (entry.isFile() && entry.name.endsWith(".ts")) {
        return [entryPath];
      }

      return [];
    }),
  );

  return files.flat();
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];

      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

function isPackageImport(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isFsImport(specifier: string): boolean {
  return (
    specifier === "fs" ||
    specifier.startsWith("fs/") ||
    specifier === "node:fs" ||
    specifier.startsWith("node:fs/")
  );
}

function resolveRelativeImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  return path.resolve(path.dirname(importer), specifier).replace(/\.(?:c|m)?js$/, ".ts");
}

function sourceRelativePath(filePath: string): string {
  return path.relative(sourceRoot, filePath).split(path.sep).join("/");
}

function getViolation(rule: BoundaryRule, importer: string, specifier: string): string | null {
  if (isFsImport(specifier)) {
    return "fs";
  }

  const bannedPackage = rule.bannedPackages.find((packageName) =>
    isPackageImport(specifier, packageName),
  );

  if (bannedPackage) {
    return bannedPackage;
  }

  const resolved = resolveRelativeImport(importer, specifier);

  if (!resolved) {
    return null;
  }

  const relativePath = sourceRelativePath(resolved);

  if (relativePath.startsWith("adapters/") || relativePath.startsWith("infrastructure/")) {
    return relativePath;
  }

  return null;
}

for (const rule of boundaryRules) {
  test(`${rule.layerName} layer does not import forbidden dependencies`, async () => {
    const files = await collectTypeScriptFiles(path.join(sourceRoot, rule.directory));
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");

      for (const specifier of extractImportSpecifiers(source)) {
        const violation = getViolation(rule, file, specifier);

        if (violation) {
          violations.push(`${sourceRelativePath(file)} imports ${specifier} (${violation})`);
        }
      }
    }

    assert.deepEqual(violations, []);
  });
}

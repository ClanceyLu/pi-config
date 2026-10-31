import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Content binding for Lead-reported checks; this does not execute or certify commands. */
export function fingerprint(cwd: string, files: string[]) {
 if (!files.length || files.length > 512) throw new Error("Provide 1–512 workspace files");
 const root = realpathSync(cwd);
 const result: Record<string, string> = {}; let total = 0;
 for (const file of new Set(files)) {
  if (isAbsolute(file)) throw new Error("Verification files must be workspace-relative");
  const path = resolve(root, file), rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../")) throw new Error("Verification path escapes workspace");
  try {
   const actual = realpathSync(path), actualRel = relative(root, actual);
   if (actualRel === ".." || actualRel.startsWith("../")) throw new Error("Verification symlink escapes workspace");
   const stat = statSync(actual); if (!stat.isFile()) throw new Error("Verification expects files, not directories");
   total += stat.size; if (total > 64 * 1024 * 1024) throw new Error("Verification snapshot exceeds 64 MiB");
   result[file] = createHash("sha256").update(readFileSync(actual)).digest("hex");
  } catch (error: any) { if (error.code === "ENOENT") result[file] = "missing"; else throw error; }
 }
 return result;
}

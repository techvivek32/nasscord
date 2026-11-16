import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * Lets plain Node (24+, which strips TypeScript types itself) load the app's server modules for the
 * route tests in this folder: "@/x" resolves to src/x(.ts|.tsx|/index.ts), and extensionless relative
 * imports inside src get their extension. No bundler, no Next runtime.
 *
 *   node --test --experimental-test-module-mocks --import ./src/lib/server/__tests__/alias-hooks.mjs src/lib/server/__tests__/*.test.mjs
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** @param {string} base */
function existing(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** @param {string} file */
function resolved(file) {
  return { url: pathToFileURL(file).href, format: file.endsWith(".ts") ? "module-typescript" : undefined, shortCircuit: true };
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const file = existing(path.join(SRC, specifier.slice(2)));
      if (file) return resolved(file);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const parent = fileURLToPath(context.parentURL);
      if (parent.startsWith(SRC) && !path.extname(specifier)) {
        const file = existing(path.resolve(path.dirname(parent), specifier));
        if (file) return resolved(file);
      }
    }
    return next(specifier, context);
  },
});

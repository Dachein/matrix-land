/**
 * Node ESM resolve hook for the mini-program service tests.
 *
 * Production sources use bundler-style extensionless relative imports (`"./api"`), which
 * webpack/Taro resolve but Node's ESM resolver does not. Rather than adding `.ts`
 * extensions to application imports — which would require `allowImportingTsExtensions`
 * and let a bundler detail leak into the source — the test run supplies the resolution
 * step here.
 *
 * Usage: node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs --test ...
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];
const TARO_STUB = new URL("./test-stubs/taro.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // The published Taro runtime needs webpack build-time globals and cannot load in Node.
  if (specifier === "@tarojs/taro" || specifier.startsWith("@tarojs/taro/")) {
    return { shortCircuit: true, url: TARO_STUB };
  }
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(specifier + suffix, context);
    }
  }
  return nextResolve(specifier, context);
}

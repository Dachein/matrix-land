/**
 * Bootstrap for the mini-program service tests: registers `ts-resolve-hook.mjs` as an ESM
 * resolve/reload hook. Node requires hooks to be registered explicitly, so exporting them
 * from the `--import`ed module is not sufficient.
 *
 * Usage: node --experimental-strip-types --import ./scripts/ts-resolve-bootstrap.mjs --test ...
 */
import { register } from "node:module";

register("./ts-resolve-hook.mjs", import.meta.url);

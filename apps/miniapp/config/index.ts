import { defineConfig, type UserConfigExport } from "@tarojs/cli";
import path from "node:path";

export default defineConfig(async (merge, { mode }) => {
  const base: UserConfigExport = {
    projectName: "workspace-miniapp",
    date: "2026-09-16",
    designWidth: 750,
    deviceRatio: { 750: 1 },
    sourceRoot: "src",
    outputRoot: "dist",
    framework: "react",
    compiler: "webpack5",
    cache: { enable: true },
    mini: { compile: { include: [path.resolve(__dirname, "../../../src/shared")] }, postcss: { pxtransform: { enable: true } } },
    h5: {
      publicPath: "/", staticDirectory: "static",
      compile: { include: [path.resolve(__dirname, "../../../src/shared")] },
      webpackChain(chain) {
        // Resolve this stylesheet before Taro's H5 API-module prefix alias.
        const aliases = chain.resolve.alias.entries();
        chain.resolve.alias.clear();
        chain.resolve.alias.set("@tarojs/taro/html.css$", path.resolve(__dirname, "../node_modules/@tarojs/taro/html.css"));
        for (const [name, value] of Object.entries(aliases)) chain.resolve.alias.set(name, value);
      }
    }
  };
  const environment = mode === "development"
    ? (await import("./dev")).default
    : (await import("./prod")).default;
  return merge({}, base, environment);
});

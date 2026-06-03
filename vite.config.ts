import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";

// 버전 단일 소스 — package.json 의 version(X.Y.Z)을 빌드 시 __APP_VERSION__ 으로 주입.
// 앞으로 버전업은 package.json 의 "version" 한 곳만 수정하면 된다.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5173,
  },
});

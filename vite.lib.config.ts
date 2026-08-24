import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: [{ find: /^three$/, replacement: "three/webgpu" }],
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "ED3DM",
      formats: ["es", "iife"],
      fileName: (fmt) => (fmt === "iife" ? "ed3dm.iife.js" : "ed3dm.js"),
    },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        exports: "named",
        footer:
          'if (typeof ED3DM !== "undefined" && ED3DM.ED3DM) globalThis.ED3DM = Object.assign(ED3DM.ED3DM, ED3DM);',
      },
    },
  },
});

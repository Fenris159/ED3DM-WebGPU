import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: /^three$/, replacement: "three/webgpu" }],
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});

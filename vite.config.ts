import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

export default defineConfig({
  base: "/meshy/",
  plugins: [react()],
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      os: shim("os"),
      path: shim("path"),
      util: shim("util"),
      "node:os": shim("os"),
      "node:path": shim("path"),
      "node:util": shim("util"),
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
});

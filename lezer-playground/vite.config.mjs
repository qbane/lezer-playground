import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // Allow serving files from project root...
      // Curious to see how this works with building....
      allow: [".."],
    },
  },
  build: {
    rollupOptions: {
      plugins: [
        // @ts-ignore
        visualizer({
          filename: `${import.meta.dirname}/bundle-analyzer-result.html`,
        }),
      ],
    },
  },
  clearScreen: false,
});

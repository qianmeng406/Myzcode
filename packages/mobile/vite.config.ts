import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: HERE,
  plugins: [react()],
  server: {
    port: 5180,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      // packages/ui 源码直接被打包，其内部 @ 别名需由消费方解析（与 web 相同做法）。
      "@": resolve(HERE, "../ui/src"),
    },
  },
  optimizeDeps: {
    exclude: ["@zcode/companion", "@zcode/shared", "@zcode/rpc", "@zcode/client", "@zcode/ui", "@zcode/services"],
  },
});

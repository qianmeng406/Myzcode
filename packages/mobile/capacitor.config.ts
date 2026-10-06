import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.zcode.myzcode",
  appName: "My zcode",
  // 网页产物由 `pnpm build` 生成；Android 壳只加载本地构建（不依赖远程页面）。
  webDir: "dist",
  server: {
    // 生产壳禁用任意远程加载；调试用 cap run 注入。
    androidScheme: "https",
  },
};

export default config;

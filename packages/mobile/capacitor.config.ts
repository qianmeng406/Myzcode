import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.zcode.myzcode",
  appName: "My zcode",
  // 网页产物由 `pnpm build` 生成；Android 壳只加载本地构建（不依赖远程页面）。
  webDir: "dist",
  server: {
    // 局域网验收期用 http 源：WebView 源 http://localhost 访问 http gateway 不构成混合内容；
    // 生产部署（HTTPS gateway）后应改回 https。
    androidScheme: "http",
  },
};

export default config;

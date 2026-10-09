import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.zcode.myzcode",
  appName: "Myzcode",
  // 网页产物由 `pnpm build` 生成；Android 壳只加载本地构建（不依赖远程页面）。
  webDir: "dist",
  server: {
    // 生产接入服务为 HTTPS（默认公网入口），WebView 源 https://localhost；
    // 局域网 http 联调时改回 "http"（并保留 Manifest 的 usesCleartextTraffic）。
    androidScheme: "https",
  },
};

export default config;

/**
 * companion 模块清单：My zcode 自托管接入与转发服务。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts（Node 嵌入入口）
 * 与 client.ts（浏览器安全客户端传输，禁止引用 adapters/ 下的 Node 实现）。
 */
export const companionModule = {
  id: "companion",
  requires: ["shared", "rpc"],
  provides: ["companion-gateway", "companion-client-transport"],
  publicEntrypoints: ["contract.ts", "client.ts"],
} as const;

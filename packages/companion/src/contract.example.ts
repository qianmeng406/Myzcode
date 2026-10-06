// contract 使用示例：把 gateway 嵌入到一个 Node 进程（自托管服务入口 / 测试宿主）。
// 展示 owner 管理操作与生命周期；不代表完整部署脚本。
import { startCompanionGateway, type CompanionGatewayHandle } from "./contract.js";

export async function example(): Promise<void> {
  let gateway: CompanionGatewayHandle | null = null;
  try {
    gateway = await startCompanionGateway({
      port: 0,
      controlDbPath: "/var/lib/zcode-companion/control.db",
      allowedOrigins: ["https://companion.example.com"],
    });
    // 1) 登记一个云端节点（token 只在创建时可见一次，交给该节点的 connector）。
    const node = await gateway.owner.registerNode({
      nodeId: "cloud-baota",
      displayName: "宝塔云端",
      kind: "cloud",
    });
    console.log(`node token (store safely): ${node.token}`);
    // 2) 生成一次性配对码，手机扫码/手输后调用 /companion/pair 完成配对。
    const pairingCode = await gateway.owner.createPairingCode();
    console.log(`pairing code: ${pairingCode.code} (expires ${pairingCode.expiresAt})`);
    // 3) 设备管理。
    for (const device of await gateway.owner.listDevices()) {
      console.log(`device ${device.deviceId} ${device.revokedAt ? "(revoked)" : "(active)"}`);
    }
  } finally {
    await gateway?.stop();
  }
}

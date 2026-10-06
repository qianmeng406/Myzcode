# Companion module

自托管接入与转发服务（My zcode 手机控制端的服务端基础）。行为规格见
`specs/companion-gateway.md`。

- **唯一权威**：设备/节点登记与授权存于 `ControlStore`（node:sqlite）；gateway hub
  只持内存在线状态与 attachment 绑定；任务/会话事实永远留在既有 Agent runtime。
- **数据面字节透传**：attach 成功后 hub 在手机 WS 与 relay WS 之间逐帧转发 binary，
  不解释、不缓存；两端各自运行既有 SocketProtocol/ChannelServer/ChannelClient。
- **公开面**：`contract.ts` 暴露 gateway 启动/停止与状态类型（Node 侧）；
  `client.ts` 暴露浏览器安全的控制面客户端与 relay 通道建立（禁止 import adapters）。

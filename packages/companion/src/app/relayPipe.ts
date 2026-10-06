// 数据面透传：mobile relay 与 connector relay 之间的 binary 帧互转。
// hub 不解释、不缓存帧；超限帧直接断开（适配器层同样有 ws 消息上限兜底）。
import type { RelayJoin } from "./ports.js";

export interface RelayPair {
  close(): void;
}

export function bindRelayPair(
  mobile: RelayJoin,
  connector: RelayJoin,
  maxFrameBytes: number,
  onBroken?: () => void,
): RelayPair {
  let closed = false;
  const closeBoth = (): void => {
    if (closed) return;
    closed = true;
    mobile.close(1000, "attachment closed");
    connector.close(1000, "attachment closed");
    // 任一侧断开 = 通道已破：通知登记表拆除 attachment（清理手机关联 +
    // attachmentClosed 事件 + 节点 detach），否则 active 记录会残留到超时。
    onBroken?.();
  };
  const forward = (from: RelayJoin, to: RelayJoin): void => {
    // 透传经包装：捕获二进制流由适配器的 onBinary 回调注入（见 adapters/relaySocket.ts）。
    from.onBinary((data) => {
      if (closed) return;
      if (data.byteLength > maxFrameBytes) {
        to.close(1009, "frame too large");
        closeBoth();
        return;
      }
      to.sendBinary(data);
    });
    from.onClosed(closeBoth);
  };
  forward(mobile, connector);
  forward(connector, mobile);
  return { close: closeBoth };
}

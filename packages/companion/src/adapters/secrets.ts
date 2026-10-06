// node:crypto 适配：随机 token 与 sha256 指纹（SecretBox）、系统时钟（Clock）。
import { createHash, randomBytes } from "node:crypto";
import type { Clock, SecretBox } from "../app/ports.js";

export class NodeSecretBox implements SecretBox {
  randomToken(byteLength: number): string {
    return randomBytes(byteLength).toString("base64url");
  }

  sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

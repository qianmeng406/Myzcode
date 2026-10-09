// node:crypto 适配：随机 token 与 sha256 指纹（SecretBox）、系统时钟（Clock）。
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Clock, SecretBox } from "../app/ports.js";

export class NodeSecretBox implements SecretBox {
  randomToken(byteLength: number): string {
    return randomBytes(byteLength).toString("base64url");
  }

  randomInt(maxExclusive: number): number {
    return randomInt(0, maxExclusive);
  }

  sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

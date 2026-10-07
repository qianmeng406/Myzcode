// 桌面 companion 配置持久化（userData/companion.json，0600）。
// 只存连接配置与开放工作区白名单；节点令牌为 gateway 签发的本机身份凭证，
// 提供 cipher 时以 OS 凭证保护（Windows DPAPI / macOS Keychain）加密落盘。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DesktopCompanionConfig {
  enabled: boolean;
  gatewayUrl: string;
  nodeToken: string;
  /** 显式开放给手机的 workspaceIdentity 白名单；空数组 = 不开放任何工作区。 */
  allowedWorkspaces: string[];
}

/**
 * 节点令牌加解密（electron safeStorage 适配注入；纯 Node 测试用假实现）。
 * encrypt 产物自带 "enc:v1:" 前缀，plain 文本永不带该前缀，借此区分存储形态。
 */
export interface CompanionTokenCipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string | null;
}

const ENC_PREFIX = "enc:v1:";

export function isEncryptedTokenPayload(payload: string): boolean {
  return payload.startsWith(ENC_PREFIX);
}

const EMPTY_CONFIG: DesktopCompanionConfig = {
  enabled: false,
  gatewayUrl: "",
  nodeToken: "",
  allowedWorkspaces: [],
};

export function companionConfigPath(userDataDir: string): string {
  return join(userDataDir, "companion.json");
}

export async function loadCompanionConfig(
  userDataDir: string,
  cipher?: CompanionTokenCipher | null,
): Promise<DesktopCompanionConfig> {
  let raw: string;
  try {
    raw = await readFile(companionConfigPath(userDataDir), "utf8");
  } catch {
    return { ...EMPTY_CONFIG };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopCompanionConfig>;
    let nodeToken = typeof parsed.nodeToken === "string" ? parsed.nodeToken : "";
    if (nodeToken !== "" && isEncryptedTokenPayload(nodeToken)) {
      nodeToken = cipher ? (cipher.decrypt(nodeToken) ?? "") : "";
    }
    return {
      enabled: parsed.enabled === true,
      gatewayUrl: typeof parsed.gatewayUrl === "string" ? parsed.gatewayUrl : "",
      nodeToken,
      allowedWorkspaces: Array.isArray(parsed.allowedWorkspaces)
        ? parsed.allowedWorkspaces.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    // 坏文件按未配置处理，不在启动路径上抛错；但保留现场（.broken）供诊断，
    // 否则截断文件会被下一次保存静默覆盖成空 token，节点令牌永久丢失。
    await rename(companionConfigPath(userDataDir), `${companionConfigPath(userDataDir)}.broken`).catch(
      () => undefined,
    );
    return { ...EMPTY_CONFIG };
  }
}

export async function saveCompanionConfig(
  userDataDir: string,
  config: DesktopCompanionConfig,
  cipher?: CompanionTokenCipher | null,
): Promise<void> {
  const path = companionConfigPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });
  // 临时文件 + 原子替换：进程崩溃/断电不会留下截断的 JSON（截断文件下次加载
  // 会被当成未配置，随后的保存就把节点令牌清空了）。
  // 有 cipher 时令牌以 OS 凭证保护加密落盘；解密失败按未配置令牌处理。
  const persisted = {
    ...config,
    nodeToken:
      config.nodeToken === ""
        ? ""
        : cipher
          ? cipher.encrypt(config.nodeToken)
          : config.nodeToken,
  };
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, path);
}

/**
 * 一次性升级：明文令牌 → cipher 加密。load（无 cipher）→ save（有 cipher）
 * 走既有原子替换路径；无 cipher 或无明文令牌时是 no-op。
 */
export async function upgradeCompanionConfigTokenStorage(
  userDataDir: string,
  cipher: CompanionTokenCipher | null,
): Promise<void> {
  if (!cipher) return;
  const config = await loadCompanionConfig(userDataDir);
  if (config.nodeToken === "") return;
  await saveCompanionConfig(userDataDir, config, cipher);
}

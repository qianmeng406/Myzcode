// 桌面 companion 配置持久化（userData/companion.json，0600）。
// 只存连接配置与开放工作区白名单；节点令牌为 gateway 签发的本机身份凭证。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DesktopCompanionConfig {
  enabled: boolean;
  gatewayUrl: string;
  nodeToken: string;
  /** 显式开放给手机的 workspaceIdentity 白名单；空数组 = 不开放任何工作区。 */
  allowedWorkspaces: string[];
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

export async function loadCompanionConfig(userDataDir: string): Promise<DesktopCompanionConfig> {
  let raw: string;
  try {
    raw = await readFile(companionConfigPath(userDataDir), "utf8");
  } catch {
    return { ...EMPTY_CONFIG };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopCompanionConfig>;
    return {
      enabled: parsed.enabled === true,
      gatewayUrl: typeof parsed.gatewayUrl === "string" ? parsed.gatewayUrl : "",
      nodeToken: typeof parsed.nodeToken === "string" ? parsed.nodeToken : "",
      allowedWorkspaces: Array.isArray(parsed.allowedWorkspaces)
        ? parsed.allowedWorkspaces.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    // 坏文件按未配置处理，不在启动路径上抛错。
    return { ...EMPTY_CONFIG };
  }
}

export async function saveCompanionConfig(
  userDataDir: string,
  config: DesktopCompanionConfig,
): Promise<void> {
  const path = companionConfigPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

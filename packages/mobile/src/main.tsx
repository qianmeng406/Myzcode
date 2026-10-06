// My zcode 手机端入口：配置 → 工作区目录 → 工作区（会话列表/会话）。
// 认证：access token 存 sessionStorage（浏览器会话级）；Android 壳后续替换为
// 安全存储（交付说明中如实标注）。
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompanionClient } from "@zcode/companion/client";
import type { CompanionCatalogResult } from "@zcode/shared/companion-protocol";
import "./app.css";
import { WorkspaceView } from "./workspace.js";

interface CompanionConfig {
  baseUrl: string;
  accessToken: string;
}

/** 个人自托管部署的默认接入服务（配对页免填；换环境时仍可手动覆盖）。 */
const DEFAULT_GATEWAY_URL = "https://47.101.52.182";

const CONFIG_KEY = "zcode-companion-config";

function loadConfig(): CompanionConfig | null {
  try {
    const raw = window.sessionStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as CompanionConfig) : null;
  } catch {
    return null;
  }
}

type View =
  | { name: "config" }
  | { name: "catalog" }
  | {
      name: "workspace";
      node: string;
      workspacePath: string;
      workspaceIdentity: string;
      title: string;
    };

function App(): React.ReactElement {
  const [view, setView] = useState<View>(() => (loadConfig() ? { name: "catalog" } : { name: "config" }));
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<CompanionClient | null>(null);
  const configRef = useRef<CompanionConfig | null>(loadConfig());

  const ensureClient = useCallback(async (): Promise<CompanionClient> => {
    const config = configRef.current;
    if (!config) {
      setView({ name: "config" });
      throw new Error("未配置");
    }
    if (clientRef.current?.isOpen()) {
      return clientRef.current;
    }
    clientRef.current?.close();
    const client = new CompanionClient({
      baseUrl: config.baseUrl,
      accessToken: config.accessToken,
      onClose: () => setError("与接入服务的连接已断开"),
    });
    await client.connect();
    clientRef.current = client;
    return client;
  }, []);

  if (view.name === "config") {
    return (
      <ConfigView
        initial={configRef.current}
        onSaved={(config) => {
          configRef.current = config;
          window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
          setError(null);
          setView({ name: "catalog" });
        }}
      />
    );
  }
  if (view.name === "catalog") {
    return (
      <div className="app">
        <header className="topbar">
          <h1>My zcode</h1>
          <button
            className="button secondary"
            onClick={() => {
              clientRef.current?.close();
              clientRef.current = null;
              setView({ name: "config" });
            }}
          >
            设置
          </button>
        </header>
        {error !== null && <div className="error" style={{ padding: "0 16px" }}>{error}</div>}
        <CatalogView
          ensureClient={ensureClient}
          onOpen={(node, workspacePath, workspaceIdentity, title) =>
            setView({ name: "workspace", node, workspacePath, workspaceIdentity, title })
          }
        />
      </div>
    );
  }
  return (
    <WorkspaceView
      target={{
        node: view.node,
        workspacePath: view.workspacePath,
        workspaceIdentity: view.workspaceIdentity,
        title: view.title,
      }}
      ensureClient={ensureClient}
      onBackToCatalog={() => setView({ name: "catalog" })}
    />
  );
}

function ConfigView(props: {
  initial: CompanionConfig | null;
  onSaved: (config: CompanionConfig) => void;
}): React.ReactElement {
  // 个人自托管：接入服务默认指向已部署的公网入口；字段保留用于换环境，
  // 留空提交时也回落默认值——日常配对只需填 6 位配对码。
  const [baseUrl, setBaseUrl] = useState(props.initial?.baseUrl ?? DEFAULT_GATEWAY_URL);
  const [deviceName, setDeviceName] = useState("My zcode 手机");
  const [pairingCode, setPairingCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  return (
    <div className="app">
      <header className="topbar">
        <h1>接入设置</h1>
      </header>
      <div className="content">
        <label className="field">
          <span>接入服务地址</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_GATEWAY_URL}
            autoCapitalize="none"
          />
        </label>
        <label className="field">
          <span>设备名称</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
        </label>
        <label className="field">
          <span>配对码（6 位数字，一次性）</span>
          <input
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            inputMode="numeric"
            autoCapitalize="none"
          />
        </label>
        <button
          className="button"
          disabled={pairing || deviceName.trim() === "" || pairingCode.trim() === ""}
          onClick={() => {
            setPairing(true);
            setPairError(null);
            const effectiveBaseUrl = baseUrl.trim() === "" ? DEFAULT_GATEWAY_URL : baseUrl.trim();
            CompanionClient.pair({
              baseUrl: effectiveBaseUrl,
              deviceName: deviceName.trim(),
              code: pairingCode.trim(),
            })
              .then((pairResult) => {
                props.onSaved({ baseUrl: effectiveBaseUrl, accessToken: pairResult.accessToken });
              })
              .catch((pairFailure: unknown) => {
                setPairError(
                  pairFailure instanceof Error ? pairFailure.message : String(pairFailure),
                );
              })
              .finally(() => setPairing(false));
          }}
        >
          {pairing ? "配对中…" : "配对并连接"}
        </button>
        {pairError !== null && <div className="error">{pairError}</div>}
        <p className="muted">配对码一次性有效（15 分钟）；配对成功后自动获得访问令牌。</p>
      </div>
    </div>
  );
}

function CatalogView(props: {
  ensureClient: () => Promise<CompanionClient>;
  onOpen: (nodeId: string, workspacePath: string, workspaceIdentity: string, title: string) => void;
}): React.ReactElement {
  const [catalog, setCatalog] = useState<CompanionCatalogResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    // interval 句柄必须挂在 effect 作用域：写在 async IIFE 内 return 的清理函数
    // 不会被 React 采用，组件卸载后 10s 轮询会泄漏。
    let interval: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      try {
        const client = await props.ensureClient();
        const load = async (): Promise<void> => {
          const result = await client.catalog();
          if (!disposed) setCatalog(result);
        };
        await load();
        if (disposed) return;
        interval = setInterval(() => void load().catch(() => undefined), 10_000);
      } catch (catalogError) {
        if (!disposed) {
          setError(catalogError instanceof Error ? catalogError.message : String(catalogError));
        }
      }
    })();
    return () => {
      disposed = true;
      if (interval !== null) clearInterval(interval);
    };
  }, [props.ensureClient]);
  return (
    <div className="content">
      {error !== null && <div className="error">{error}</div>}
      <button
        className="card"
        style={{ marginBottom: 12, textAlign: "left" }}
        onClick={() => {
          // 完整 Web UI（同 WebView 子路径，sessionStorage 配置直接交接）。
          window.location.href = "webui/index.html?companion=1";
        }}
      >
        打开完整界面
        <div className="sub">桌面级完整 UI（工作区/差异/文件树），经同一接入服务</div>
      </button>
      {catalog === null && <p className="muted">正在加载工作区…</p>}
      {catalog?.nodes.map((node) => (
        <div key={node.nodeId}>
          <p className="muted" style={{ padding: "8px 0", textAlign: "left" }}>
            <span className={node.online ? "dot on" : "dot off"} />
            {node.displayName}（{node.kind === "cloud" ? "云端" : "电脑"}）
          </p>
          {node.workspaces.map((workspace) => (
            <button
              key={`${node.nodeId}:${workspace.workspaceIdentity}`}
              className="card"
              disabled={!node.online || !workspace.available}
              onClick={() =>
                props.onOpen(node.nodeId, workspace.workspacePath, workspace.workspaceIdentity, workspace.title)
              }
            >
              {workspace.title}
              <div className="sub">
                {workspace.available ? "可用" : "运行端不可用"} · {workspace.workspacePath}
              </div>
            </button>
          ))}
          {node.online && node.workspaces.length === 0 && (
            <p className="muted" style={{ textAlign: "left", padding: "4px 0" }}>
              该节点未开放工作区
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

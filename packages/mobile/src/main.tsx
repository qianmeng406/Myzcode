// Myzcode 手机端入口：配置 → 工作区目录 → 工作区（会话列表/会话）。
// 认证：access token 优先存 sessionStorage（会话级），另以 12h 短时 token 落
// localStorage 作恢复回退（服务端可即时撤销）；长期 refresh 只走 HttpOnly Cookie。
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompanionClient } from "@zcode/companion/client";
import { CompanionConnectionSession } from "@zcode/companion/connection-session";
import "./app.css";
import { CatalogView } from "./catalog.js";
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

/**
 * 持久恢复（App 重启后免重配对），按优先级：
 * 1) HttpOnly refresh Cookie（WebView 持久化；force-stop 可能丢未 flush 的
 *    Cookie，故不能只依赖它）→ 静默换新 access；
 * 2) 上次配对的 access token（12h 短时、服务端可即时撤销）+ 端点——
 *    有效期内恢复，过期则回配对页。长期 refresh 凭证不落 localStorage。
 */
const ENDPOINT_KEY = "zcode-companion-endpoint";
const PERSIST_KEY = "zcode-companion-persist";
/** 用户在完整 UI 里点过"轻量界面"后置位：之后恢复/配对停在轻量目录页。 */
const PREFER_LIGHT_KEY = "zcode-companion-prefer-light";

function openFullUi(): void {
  // 完整 Web UI 在同 WebView 子路径（sessionStorage 配置直接交接，免重新认证）。
  window.location.href = "webui/index.html?companion=1";
}

function loadPersistedConfig(): { baseUrl: string; accessToken: string } | null {
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CompanionConfig>;
    if (typeof parsed.baseUrl === "string" && typeof parsed.accessToken === "string") {
      return { baseUrl: parsed.baseUrl, accessToken: parsed.accessToken };
    }
  } catch {
    // 坏数据按未配置处理。
  }
  return null;
}

async function tryRecoverSession(): Promise<CompanionConfig | null> {
  const baseUrl = window.localStorage.getItem(ENDPOINT_KEY);
  if (baseUrl) {
    try {
      const result = await CompanionClient.refresh({ baseUrl });
      const config: CompanionConfig = { baseUrl, accessToken: result.accessToken };
      window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      // 同步刷新持久回退：否则 Cookie 再次丢失时会退回更旧的（可能已过期的）
      // token，白白多走一次配对。
      window.localStorage.setItem(PERSIST_KEY, JSON.stringify(config));
      return config;
    } catch {
      // Cookie 不在（force-stop 丢失/过期）→ 回退持久 token。
    }
  }
  const persisted = loadPersistedConfig();
  if (!persisted) return null;
  try {
    const client = new CompanionClient({
      baseUrl: persisted.baseUrl,
      accessToken: persisted.accessToken,
    });
    await client.connect();
    const result = await client.catalog();
    client.close();
    if (!result.nodes.length) return null;
    window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(persisted));
    return persisted;
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
  const configRef = useRef<CompanionConfig | null>(loadConfig());
  const sessionRef = useRef<CompanionConnectionSession | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const everConnectedRef = useRef(false);
  // 连接代次：掉线重连成功后 +1，工作区视图据此 re-attach 并重建订阅。
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  // 唯一连接所有者：目录/工作区/完整 UI 共用；重连、静默刷新、前台探测都在这里。
  const ensureSession = useCallback((config: CompanionConfig): CompanionConnectionSession => {
    const key = `${config.baseUrl}|${config.accessToken}`;
    if (sessionRef.current !== null && sessionKeyRef.current === key) {
      return sessionRef.current;
    }
    sessionRef.current?.stop();
    const session = new CompanionConnectionSession({
      baseUrl: config.baseUrl,
      accessToken: config.accessToken,
      refresh: async (baseUrl) => {
        const result = await CompanionClient.refresh({ baseUrl });
        const next = { baseUrl, accessToken: result.accessToken };
        configRef.current = next;
        window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(next));
        window.localStorage.setItem(PERSIST_KEY, JSON.stringify(next));
        return result.accessToken;
      },
      onStateChange: (state) => {
        if (state === "connected") {
          setError(null);
          if (everConnectedRef.current) setConnectionEpoch((epoch) => epoch + 1);
          everConnectedRef.current = true;
        } else if (state === "reconnecting") {
          setError("与接入服务的连接已断开，正在重连…");
        } else if (state === "authExpired") {
          // 刷新也失效：清会话回配对页（refresh Cookie 已死，不能再自动恢复）。
          configRef.current = null;
          window.sessionStorage.removeItem(CONFIG_KEY);
          window.localStorage.removeItem(PERSIST_KEY);
          setError("登录已过期，请重新配对");
          setView({ name: "config" });
        }
      },
    });
    session.start();
    sessionRef.current = session;
    sessionKeyRef.current = key;
    return session;
  }, []);

  // Cookie 会话恢复：access 缺失但 endpoint 已记住时，静默刷新一轮；
  // 成功直接进目录页（配对跨 App 重启持久），失败留在配对页。
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (configRef.current || recovered) return;
    void (async () => {
      const config = await tryRecoverSession();
      // 恢复在途时用户可能已完成手动配对：不得用旧 token 覆盖新配置。
      if (config && configRef.current === null) {
        configRef.current = config;
        if (window.localStorage.getItem(PREFER_LIGHT_KEY) === "1") {
          setView({ name: "catalog" });
        } else {
          openFullUi();
        }
      }
      setRecovered(true);
    })();
  }, [recovered]);

  // 前台恢复即时探测：WebView 回前台时取消退避等待，立即尝试重连。
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") sessionRef.current?.nudge();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", () => sessionRef.current?.nudge());
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const ensureClient = useCallback(async (): Promise<CompanionClient> => {
    const config = configRef.current;
    if (!config) {
      setView({ name: "config" });
      throw new Error("未配置");
    }
    const client = await ensureSession(config).ensureConnected();
    // 会话默认工厂持有完整 CompanionClient（catalog/attach/relay 只在它上面）。
    return client as CompanionClient;
  }, [ensureSession]);

  if (view.name === "config") {
    return (
      <ConfigView
        initial={configRef.current}
        onSaved={(config) => {
          configRef.current = config;
          window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
          window.localStorage.setItem(ENDPOINT_KEY, config.baseUrl);
          window.localStorage.setItem(PERSIST_KEY, JSON.stringify(config));
          setError(null);
          // 配对成功默认直达完整 Web UI（B 阶段主体验）；轻量页作为后备入口。
          if (window.localStorage.getItem(PREFER_LIGHT_KEY) === "1") {
            setView({ name: "catalog" });
          } else {
            openFullUi();
          }
        }}
      />
    );
  }
  if (view.name === "catalog") {
    return (
      <div className="app">
        <header className="topbar">
          <h1>Myzcode</h1>
          <button
            className="button secondary"
            onClick={() => {
              sessionRef.current?.stop();
              sessionRef.current = null;
              sessionKeyRef.current = null;
              everConnectedRef.current = false;
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
          onOpenFullUi={() => {
            openFullUi();
            // 用户主动进完整 UI：清除“偏好轻量”标记，下次恢复仍直达完整界面。
            window.localStorage.removeItem(PREFER_LIGHT_KEY);
          }}
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
      connectionEpoch={connectionEpoch}
      onBackToCatalog={() => setView({ name: "catalog" })}
    />
  );
}

function ConfigView(props: {
  initial: CompanionConfig | null;
  onSaved: (config: CompanionConfig) => void;
}): React.ReactElement {
  // 个人自托管：接入服务默认指向已部署的公网入口；字段收进「更多选项」，
  // 日常配对只需输入桌面端显示的 6 位配对码。
  const [baseUrl, setBaseUrl] = useState(props.initial?.baseUrl ?? DEFAULT_GATEWAY_URL);
  const [deviceName, setDeviceName] = useState("Myzcode 手机");
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  const code = digits.join("");
  const codeComplete = code.length === 6 && !digits.some((digit) => digit === "");

  const setDigit = (index: number, value: string): void => {
    const clean = value.replace(/\D/g, "");
    if (clean === "") {
      setDigits((prev) => prev.map((digit, i) => (i === index ? "" : digit)));
      return;
    }
    if (clean.length > 1) {
      // 粘贴整段验证码：从当前格依次填充。
      setDigits((prev) => {
        const next = [...prev];
        for (let offset = 0; offset < clean.length && index + offset < 6; offset += 1) {
          next[index + offset] = clean[offset] ?? "";
        }
        return next;
      });
      const target = Math.min(index + clean.length, 5);
      inputsRef.current[target]?.focus();
      return;
    }
    setDigits((prev) => prev.map((digit, i) => (i === index ? clean : digit)));
    if (index < 5) inputsRef.current[index + 1]?.focus();
  };

  const onDigitKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Backspace" && digits[index] === "" && index > 0) {
      inputsRef.current[index - 1]?.focus();
      setDigits((prev) => prev.map((digit, i) => (i === index - 1 ? "" : digit)));
      event.preventDefault();
    }
  };

  return (
    <div className="app">
      <div className="hero">
        <div className="hero-icon">Z</div>
        <h1>Myzcode</h1>
        <p>输入电脑端显示的 6 位配对码，连接你的工作区</p>
      </div>
      <div className="content">
        <div className="code-input" aria-label="配对码">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(element) => {
                inputsRef.current[index] = element;
              }}
              value={digit}
              onChange={(event) => setDigit(index, event.target.value)}
              onKeyDown={(event) => onDigitKeyDown(index, event)}
              onFocus={(event) => event.currentTarget.select()}
              inputMode="numeric"
              autoComplete={index === 0 ? "one-time-code" : "off"}
              maxLength={6}
              className={digit === "" ? "" : "filled"}
            />
          ))}
        </div>
        <button
          className="button primary-block"
          disabled={pairing || !codeComplete || deviceName.trim() === ""}
          onClick={() => {
            setPairing(true);
            setPairError(null);
            const effectiveBaseUrl = baseUrl.trim() === "" ? DEFAULT_GATEWAY_URL : baseUrl.trim();
            CompanionClient.pair({
              baseUrl: effectiveBaseUrl,
              deviceName: deviceName.trim(),
              code,
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
        <p className="hint-line">配对码一次性有效（15 分钟），在电脑端「Myzcode 桌面直连」弹窗生成。</p>
        <details className="advanced">
          <summary>更多选项</summary>
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
        </details>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

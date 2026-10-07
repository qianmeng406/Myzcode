// Myzcode 手机端入口 = 官方 WebRemoteControlMobileShell 的结构复刻：
// 单页 home(任务首页) ↔ chat(任务会话)，history.pushState({zcodeMobilePage:'chat'})
// + popstate 收口（官方 x5t 语义，Android 返回键自然生效）。
// 认证：access token 优先存 sessionStorage（会话级），另以 12h 短时 token 落
// localStorage 作恢复回退（服务端可即时撤销）；长期 refresh 只走 HttpOnly Cookie。
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App as CapacitorApp } from "@capacitor/app";
import { CompanionClient } from "@zcode/companion/client";
import { CompanionConnectionSession } from "@zcode/companion/connection-session";
import "./app.css";
import { CONFIG_KEY, ENDPOINT_KEY, PERSIST_KEY, tryRecoverSession, type CompanionConfig } from "./recover.js";
import { TaskHomeView } from "./taskHome.js";
import { ChatView } from "./workspace.js";
import { useTheme } from "./ui.js";

/** 个人自托管部署的默认接入服务（配对页免填；换环境时仍可手动覆盖）。 */
const DEFAULT_GATEWAY_URL = "https://47.101.52.182";

function loadConfig(): CompanionConfig | null {
  try {
    const raw = window.sessionStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as CompanionConfig) : null;
  } catch {
    return null;
  }
}

function openFullUi(): void {
  // 完整 Web UI 在同 WebView 子路径（官方 >767px 形态，手机端从菜单进入）。
  window.location.href = "webui/index.html?companion=1";
}

interface ChatTarget {
  node: string;
  workspacePath: string;
  workspaceIdentity: string;
  title: string;
  /** null = 保持既有会话；"" = 新任务草稿；非空 = 任务直达。 */
  initialSessionId: string | null;
}

type View = { name: "config" } | { name: "home" } | { name: "chat"; target: ChatTarget };

function App(): React.ReactElement {
  const [view, setView] = useState<View>(() => (loadConfig() ? { name: "home" } : { name: "config" }));
  const { theme, setTheme } = useTheme();
  const configRef = useRef<CompanionConfig | null>(loadConfig());
  const sessionRef = useRef<CompanionConnectionSession | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const everConnectedRef = useRef(false);
  // 连接代次：掉线重连成功后 +1，chat 视图据此 re-attach 并重建订阅。
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  // 唯一连接所有者：首页/chat/完整 UI 共用；重连、静默刷新、前台探测都在这里。
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
          if (everConnectedRef.current) setConnectionEpoch((epoch) => epoch + 1);
          everConnectedRef.current = true;
        } else if (state === "authExpired") {
          // 刷新也失效：清会话回配对页（refresh Cookie 已死，不能再自动恢复）。
          configRef.current = null;
          window.sessionStorage.removeItem(CONFIG_KEY);
          window.localStorage.removeItem(PERSIST_KEY);
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
  // 成功直接进手机端首页（配对跨 App 重启持久），失败留在配对页。
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (configRef.current || recovered) return;
    void (async () => {
      const config = await tryRecoverSession();
      // 恢复在途时用户可能已完成手动配对：不得用旧 token 覆盖新配置。
      if (config && configRef.current === null) {
        configRef.current = config;
        // 官方语义：手机视口直接进 MobileShell 任务首页，完整 UI 由菜单进入。
        setView({ name: "home" });
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

  // 官方 popstate 语义：chat 历史项出栈 = 回首页（Android 返回键同一通路）。
  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      if ((event.state as { zcodeMobilePage?: string } | null)?.zcodeMobilePage === "chat") {
        return;
      }
      setView((current) => (current.name === "chat" ? { name: "home" } : current));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Android 硬件返回键（Capacitor 7 默认直接退出，需 JS 接管）：
  // 优先关开着的弹层（sheet/菜单），再 chat→home（popstate 通路），home 上退出。
  useEffect(() => {
    const handleRef: { current: { remove: () => Promise<void> } | null } = { current: null };
    let disposed = false;
    void CapacitorApp.addListener("backButton", () => {
      if (document.querySelector(".sheet-mask") !== null) {
        window.dispatchEvent(new CustomEvent("zcode-close-sheets"));
        return;
      }
      if (document.querySelector(".menu-pop") !== null) {
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return;
      }
      if ((window.history.state as { zcodeMobilePage?: string } | null)?.zcodeMobilePage === "chat") {
        window.history.back();
        return;
      }
      void CapacitorApp.exitApp();
    }).then((handle) => {
      if (disposed) void handle.remove();
      else handleRef.current = handle;
    });
    return () => {
      disposed = true;
      void handleRef.current?.remove();
    };
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
          // 官方语义：配对成功即进手机任务首页（MobileShell）；完整 UI 从整理菜单进入。
          setView({ name: "home" });
        }}
      />
    );
  }

  if (view.name === "home") {
    return (
      <div className="shell-root">
        <TaskHomeView
          ensureClient={ensureClient}
          theme={theme}
          onThemeChange={setTheme}
          onOpenTask={(nodeId, workspacePath, workspaceIdentity, title, sessionId) => {
            // 官方 d8t：打开任务 = 压入 chat 历史 + 进入 chat 页。
            window.history.pushState({ zcodeMobilePage: "chat" }, "");
            setView({
              name: "chat",
              target: { node: nodeId, workspacePath, workspaceIdentity, title, initialSessionId: sessionId },
            });
          }}
          onOpenFullUi={() => openFullUi()}
          onOpenSettings={() => {
            sessionRef.current?.stop();
            sessionRef.current = null;
            sessionKeyRef.current = null;
            everConnectedRef.current = false;
            setView({ name: "config" });
          }}
        />
      </div>
    );
  }

  return (
    <ChatView
      target={view.target}
      initialSessionId={view.target.initialSessionId}
      ensureClient={ensureClient}
      connectionEpoch={connectionEpoch}
      onBackHome={() => setView({ name: "home" })}
      onSwitchWorkspace={(candidate) => {
        // 官方语义：chat 页内切换目标，保持 chat 页与加载浮层。
        setView((current) =>
          current.name === "chat"
            ? {
                name: "chat",
                target: {
                  node: candidate.node,
                  workspacePath: candidate.workspacePath,
                  workspaceIdentity: candidate.workspaceIdentity,
                  title: candidate.title,
                  initialSessionId: null,
                },
              }
            : current,
        );
      }}
      theme={theme}
      onThemeChange={setTheme}
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
    <div className="pair-root">
      <header className="pair-header">
        <h1>Myzcode</h1>
        <p>输入电脑端显示的 6 位配对码，连接你的工作区</p>
      </header>
      <div className="pair-body">
        <div className="pair-card">
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
            type="button"
            className="button-primary-block"
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
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

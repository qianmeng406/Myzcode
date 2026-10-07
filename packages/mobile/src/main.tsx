// Myzcode 手机壳入口。方向（对齐官方）：远控移动端 = 同一个 WebUI + 窄视口
// 适配（见 packages/web/src/companionMobile.css），本壳只承担两件事：
// 1) 首次配对（6 位码）——WebUI 的 companion 引导读取同源 sessionStorage 配置；
// 2) 配对成功/会话恢复后直接进入完整 WebUI（webui/index.html?companion=1）。
// 认证：access token 存 sessionStorage（会话级，配对后与 WebUI 同源交接），
// 另以 12h 短时 token 落 localStorage 作恢复回退（服务端可即时撤销）；
// 长期 refresh 只走 HttpOnly Cookie。
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompanionClient } from "@zcode/companion/client";
import { CONFIG_KEY, ENDPOINT_KEY, PERSIST_KEY, tryRecoverSession, type CompanionConfig } from "./recover.js";
import "./app.css";

/** 个人自托管部署的默认接入服务（配对页免填；换环境时仍可手动覆盖）。 */
const DEFAULT_GATEWAY_URL = "https://47.101.52.182";

/** 完整 WebUI 子路径：companion 引导读同源 sessionStorage 的配对配置。 */
function openFullUi(): void {
  window.location.href = "webui/index.html?companion=1";
}

function loadConfig(): CompanionConfig | null {
  try {
    const raw = window.sessionStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as CompanionConfig) : null;
  } catch {
    return null;
  }
}

function ConfigView(props: {
  initial: CompanionConfig | null;
  onSaved: (config: CompanionConfig) => void;
}): React.ReactElement {
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
                  setPairError(pairFailure instanceof Error ? pairFailure.message : String(pairFailure));
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

function Shell(): React.ReactElement | null {
  const [booted, setBooted] = useState(false);
  const recoveredRef = useRef(false);

  // 已有会话配置：直接进 WebUI（companion 引导接手连接/断连状态屏）。
  // 无配置：先做一轮 Cookie 静默恢复，成功同样直达；失败停留配对页。
  const enter = useCallback((): void => {
    if (loadConfig() !== null) {
      openFullUi();
      return;
    }
    void (async () => {
      if (recoveredRef.current) return;
      recoveredRef.current = true;
      const config = await tryRecoverSession();
      if (config !== null) openFullUi();
      else setBooted(true);
    })();
  }, []);

  if (booted) {
    return (
      <ConfigView
        initial={null}
        onSaved={(config) => {
          window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
          window.localStorage.setItem(ENDPOINT_KEY, config.baseUrl);
          window.localStorage.setItem(PERSIST_KEY, JSON.stringify(config));
          openFullUi();
        }}
      />
    );
  }
  void enter();
  return (
    <div className="pair-root">
      <div className="pair-body">
        <p className="hint-line" style={{ textAlign: "center", marginTop: "40vh" }}>
          正在进入 Myzcode…
        </p>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Shell />);

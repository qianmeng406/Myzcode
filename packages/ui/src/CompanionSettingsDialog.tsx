// My zcode 桌面直连设置对话框：启用开关 + 开放工作区白名单 + 手机配对码。
// 主路径是「生成配对码」：主进程用已存节点令牌向 gateway 索取一次性 6 位码，
// 用户在手机 Myzcode 输入即完成配对——无需手工保管/粘贴节点令牌。
// 数据面走 IPlatformService.getCompanionConfig/setCompanionConfig/requestCompanionPairingCode
// （仅 Desktop 实现），Web/移动端入口不渲染此区块。
// 网关地址与节点令牌收敛进「高级设置」折叠区，仅初次部署或迁移时使用。
import { memo, useEffect, useState } from "react";
import { Loader2, MonitorSmartphone, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

interface CompanionConfigView {
  enabled: boolean;
  gatewayUrl: string;
  hasNodeToken: boolean;
  allowedWorkspaces: string[];
}

interface PairingCodeView {
  code: string;
  expiresAt: number;
  displayName: string;
}

/** 配对码剩余秒数；已过期归零。 */
function pairingSecondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export const CompanionSettingsDialog = memo(function CompanionSettingsDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [config, setConfig] = useState<CompanionConfigView | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [nodeToken, setNodeToken] = useState("");
  const [shareCurrent, setShareCurrent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingCodeView | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const identity = workspaceIdentity?.trim() || workspacePath.trim();

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setConfig(null);
    setError(null);
    setSaved(false);
    setPairing(null);
    setPairingError(null);
    void (async () => {
      try {
        if (typeof platform.getCompanionConfig !== "function") {
          if (!disposed) setConfig({ enabled: false, gatewayUrl: "", hasNodeToken: false, allowedWorkspaces: [] });
          return;
        }
        const loaded = await platform.getCompanionConfig();
        if (disposed) return;
        setConfig(loaded);
        setGatewayUrl(loaded.gatewayUrl);
        setShareCurrent(loaded.allowedWorkspaces.includes(identity));
      } catch (loadError) {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [open, identity, platform]);

  // 配对码倒计时：有码时每秒刷新 now，过期后自动清空展示态。
  useEffect(() => {
    if (pairing === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (pairing !== null && pairingSecondsLeft(pairing.expiresAt, now) === 0) {
      setPairing(null);
    }
  }, [pairing, now]);

  const unavailable = typeof platform.setCompanionConfig !== "function";

  const handleSave = (): void => {
    if (platform.setCompanionConfig === undefined) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const currentAllowed = config?.allowedWorkspaces ?? [];
    const nextAllowed = shareCurrent
      ? currentAllowed.includes(identity)
        ? currentAllowed
        : [...currentAllowed, identity]
      : currentAllowed.filter((entry) => entry !== identity);
    void platform
      .setCompanionConfig({
        enabled: config?.enabled === true,
        gatewayUrl: gatewayUrl.trim(),
        // 留空 = 保留已存令牌（主进程不回传秘密）。
        ...(nodeToken.trim() !== "" ? { nodeToken: nodeToken.trim() } : {}),
        allowedWorkspaces: nextAllowed,
      })
      .then(() => {
        setSaved(true);
        setNodeToken("");
        logger.info("[CompanionSettingsDialog] 配置已保存", {
          workspaceIdentity: identity,
          shared: shareCurrent,
        });
      })
      .catch((saveError: unknown) => {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      })
      .finally(() => setSaving(false));
  };

  const generatePairingCode = (): void => {
    if (platform.requestCompanionPairingCode === undefined) return;
    setPairingLoading(true);
    setPairingError(null);
    void platform
      .requestCompanionPairingCode()
      .then((issued) => {
        setNow(Date.now());
        setPairing({ code: issued.code, expiresAt: issued.expiresAt, displayName: issued.displayName });
      })
      .catch((pairError: unknown) => {
        setPairingError(pairError instanceof Error ? pairError.message : String(pairError));
      })
      .finally(() => setPairingLoading(false));
  };

  const secondsLeft = pairing === null ? 0 : pairingSecondsLeft(pairing.expiresAt, now);
  // 生成配对码要求：已配置（网关+令牌）且已启用——未启用时配对成功也看不到节点。
  const configured =
    (config?.gatewayUrl.trim() ?? "") !== "" &&
    config?.hasNodeToken === true &&
    config?.enabled === true;
  // 高级设置表单有未保存修改时禁止取码：主进程只会用已保存配置请求，
  // 否则用户拿到的是"旧网关"的配对码（对手机无效），排查链路极长。
  const formDirty =
    gatewayUrl.trim() !== (config?.gatewayUrl ?? "").trim() || nodeToken.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-6rem)] max-w-lg gap-0 overflow-hidden rounded-2xl p-0">
        <div className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5">
          <DialogHeader className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                <MonitorSmartphone className="size-5" />
              </div>
              <div className="space-y-1">
                <DialogTitle>{intl.formatMessage({ id: "companionDirect.title" })}</DialogTitle>
                <DialogDescription>
                  {intl.formatMessage({ id: "companionDirect.description" })}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {unavailable ? (
            <p className="mt-5 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "companionDirect.notAvailable" })}
            </p>
          ) : config === null ? (
            <div className="mt-5 flex items-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" />
              {intl.formatMessage({ id: "companionDirect.loading" })}
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
                <div className="space-y-1">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: "companionDirect.enabled" })}
                  </div>
                  <p className="text-ui-base/relaxed text-foreground-subtle">
                    {intl.formatMessage({ id: "companionDirect.enabledHint" })}
                  </p>
                </div>
                <Switch
                  checked={config.enabled}
                  onCheckedChange={(checked) => setConfig({ ...config, enabled: checked })}
                />
              </div>

              <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "companionDirect.pairingTitle" })}
                </div>
                {pairing === null ? (
                  <div className="space-y-3">
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {configured
                        ? intl.formatMessage({ id: "companionDirect.pairingIdle" })
                        : intl.formatMessage({ id: "companionDirect.notConfigured" })}
                    </p>
                    {formDirty && (
                      <p className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: "companionDirect.saveFirst" })}
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pairingLoading || !configured || formDirty}
                      onClick={generatePairingCode}
                    >
                      {pairingLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        intl.formatMessage({ id: "companionDirect.pairingGenerate" })
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div
                      className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface py-3"
                      aria-live="polite"
                    >
                      {pairing.code.split("").map((digit, index) => (
                        <span
                          key={`${index}-${digit}`}
                          className="min-w-9 rounded-md bg-background py-1 text-center font-mono text-2xl font-semibold tabular-nums text-foreground"
                        >
                          {digit}
                        </span>
                      ))}
                    </div>
                    {pairing.displayName !== "" && (
                      <p className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage(
                          { id: "companionDirect.pairingNode" },
                          { name: pairing.displayName },
                        )}
                      </p>
                    )}
                    <p className="text-ui-sm/relaxed text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "companionDirect.pairingHint" },
                        { seconds: secondsLeft },
                      )}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pairingLoading}
                      onClick={generatePairingCode}
                    >
                      {pairingLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <>
                          <RefreshCw className="size-3.5" />
                          {intl.formatMessage({ id: "companionDirect.pairingRegenerate" })}
                        </>
                      )}
                    </Button>
                  </div>
                )}
                {pairingError !== null && (
                  <p className="text-ui-sm text-destructive">
                    {intl.formatMessage({ id: "companionDirect.pairingFailed" })}：{pairingError}
                  </p>
                )}
              </div>

              <label className="flex items-center gap-2">
                <Checkbox checked={shareCurrent} onCheckedChange={(checked) => setShareCurrent(checked === true)} />
                <span className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "companionDirect.shareCurrent" })}
                </span>
              </label>
              <p className="text-ui-sm text-foreground-subtle">{workspacePath}</p>

              <details className="rounded-xl border border-border bg-card p-4">
                <summary className="cursor-pointer text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "companionDirect.advanced" })}
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="companion-gateway-url">
                      {intl.formatMessage({ id: "companionDirect.gatewayUrl" })}
                    </Label>
                    <Input
                      id="companion-gateway-url"
                      value={gatewayUrl}
                      onChange={(event) => setGatewayUrl(event.target.value)}
                      placeholder="wss://companion.example.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="companion-node-token">
                      {intl.formatMessage({ id: "companionDirect.nodeToken" })}
                    </Label>
                    <Input
                      id="companion-node-token"
                      type="password"
                      value={nodeToken}
                      onChange={(event) => setNodeToken(event.target.value)}
                      placeholder={
                        config.hasNodeToken
                          ? intl.formatMessage({ id: "companionDirect.nodeTokenSaved" })
                          : intl.formatMessage({ id: "companionDirect.nodeTokenPlaceholder" })
                      }
                    />
                  </div>
                </div>
              </details>

              {error !== null && (
                <p className="text-ui-sm text-destructive">{error}</p>
              )}

              <div className="flex items-center gap-3">
                <Button type="button" disabled={saving} onClick={handleSave}>
                  {saving
                    ? intl.formatMessage({ id: "companionDirect.saving" })
                    : intl.formatMessage({ id: "companionDirect.save" })}
                </Button>
                {saved && (
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "companionDirect.saved" })}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});

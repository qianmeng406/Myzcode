// My zcode 桌面直连设置对话框：配置自托管 gateway、节点令牌与开放工作区白名单。
// 数据面走 IPlatformService.getCompanionConfig/setCompanionConfig（仅 Desktop 实现），
// Web/移动端入口不渲染此区块。节点令牌在 gateway owner 面板生成（registerNode），
// 只在输入时经过 renderer，不回显（getConfig 只回 hasNodeToken）。
import { memo, useEffect, useState } from "react";
import { Loader2, MonitorSmartphone } from "lucide-react";
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
  const identity = workspaceIdentity?.trim() || workspacePath.trim();

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setConfig(null);
    setError(null);
    setSaved(false);
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

              <label className="flex items-center gap-2">
                <Checkbox checked={shareCurrent} onCheckedChange={(checked) => setShareCurrent(checked === true)} />
                <span className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "companionDirect.shareCurrent" })}
                </span>
              </label>
              <p className="text-ui-sm text-foreground-subtle">{workspacePath}</p>

              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "companionDirect.hint" })}
              </p>

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

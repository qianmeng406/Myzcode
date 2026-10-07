// 手机端能力矩阵（A4）：UI 依据它渲染/隐藏入口；它不替代服务端鉴权
// （narrowing facade / channel policy 是真正的围栏），只保证不把不可用
// 能力画成可点按钮。
// 开放面与 specs/companion-gateway.md §11 及 narrowingFacade ALLOWED_* 对齐。

export interface MobileCapabilities {
  /** 任务创建 / 文本跟进 / 停止（v4 命令白名单内）。 */
  taskCommands: boolean;
  /** 选项式 + 自由文本 + 多题 + 计划批准（resolveInteraction answer 全形状）。 */
  interactions: boolean;
  /** 会话列表实时订阅（sessions-index transport）。 */
  sessionsIndex: boolean;
  /** turnHeader 文件变更摘要 + unified diff 只读视图（无任何写入口）。 */
  readonlyFileDiff: boolean;
  /** 会话级模式切换（setMode：构建/编辑/计划/自动）。 */
  modeSwitch: boolean;
  /** 工作区切换（detach → attach，同设备单 attachment）。 */
  workspaceSwitch: boolean;
  /** 终端 / 文件写入 / 插件管理 / 凭据管理 —— 永不下发手机。 */
  terminal: false;
  fileWrite: false;
  pluginManagement: false;
  credentialManagement: false;
}

/** 当前手机端能力面（显式 false 的项由 UI 隐藏，不出现在任何入口）。 */
export const MOBILE_CAPABILITIES: MobileCapabilities = {
  taskCommands: true,
  interactions: true,
  sessionsIndex: true,
  readonlyFileDiff: true,
  modeSwitch: true,
  workspaceSwitch: true,
  terminal: false,
  fileWrite: false,
  pluginManagement: false,
  credentialManagement: false,
};

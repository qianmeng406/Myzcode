import { z } from "zod";

/** auto 保留为内部权限；plan 仅在旧格式读取边界接受；research 为只读资料查询模式；
 * minimal 为极简模式（system 段只留身份行与环境，无 skill / memory / 项目 instructions，且不下发 MCP 工具）；
 * zcodeUpdate 为 ZCode 更新模式（跟进官方发版：取 diff → 分析 → 本地实现 → 验收，权限同 yolo 自动执行）。 */
export const executionPermissionModeSchema = z.enum([
  "build",
  "edit",
  "yolo",
  "auto",
  "research",
  "minimal",
  "zcodeUpdate",
]);
export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planEnabled: z.boolean(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

/** 在接纳边界固定旧请求语义，不能在队列消费时按当前配置重新解释。 */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean },
  current: ExecutionState = { mode: "build", planEnabled: false },
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  return {
    mode: mode.success ? mode.data : current.mode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
  };
}

import { z } from "zod";

/** auto 保留为内部权限；plan 仅在旧格式读取边界接受；research 为只读资料查询模式；
 * workflow 为标准工作流交付模式（权限同 build，靠 reminder 驱动台账/阶段/对抗轮纪律）。 */
export const executionPermissionModeSchema = z.enum([
  "build",
  "edit",
  "yolo",
  "auto",
  "research",
  "workflow",
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

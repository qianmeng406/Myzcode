// ============================================================
// Plan Mode Tools - plan approval flow
// ============================================================

import { z } from "zod";
import type { CollaborationMode } from "../interfaces/session.port.js";
import type { TraceContext } from "../tracing/tracer.js";
import { toToolJsonSchema } from "./json-schema.js";

// 与 shared/model-selection 的 modelSelectionSchema 同形状。contracts 的 zod 与
// cli shared 的 zod 是两个大版本实例，schema 不能跨实例组合，这里本地声明同构
// 值（类型对 shared 的 ModelSelection 结构兼容）。
const ExecutionModelSelectionSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    options: z
      .object({
        reasoningLevel: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

export const PLAN_MODE_MAX_PLAN_CHARS = 20_000;

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;
export const EnterPlanModeInputJsonSchema = toToolJsonSchema(EnterPlanModeInputSchema);

export const EnterPlanModeOutputSchema = z
  .object({
    message: z.string().min(1).describe("Confirmation that plan mode was entered."),
    previousMode: z
      .enum([
        "plan",
        "build",
        "edit",
        "yolo",
        "auto",
        "research",
        "workflow",
        "minimal",
        "zcodeUpdate",
      ])
      .describe("Session mode before EnterPlanMode ran."),
    mode: z
      .enum([
        "plan",
        "build",
        "edit",
        "yolo",
        "auto",
        "research",
        "workflow",
        "minimal",
        "zcodeUpdate",
      ])
      .describe("Current permission mode."),
    planEnabled: z.boolean().optional(),
    previousPlanEnabled: z.boolean().optional(),
  })
  .strict();
export type EnterPlanModeOutput = z.infer<typeof EnterPlanModeOutputSchema>;
export const EnterPlanModeOutputJsonSchema = toToolJsonSchema(EnterPlanModeOutputSchema);

export const ExitPlanModeAllowedPromptSchema = z
  .object({
    tool: z.enum(["Bash"]).describe("The tool this prompt applies to"),
    prompt: z
      .string()
      .describe('Semantic description of the action, e.g. "run tests", "install dependencies"'),
  })
  .strict();
export type ExitPlanModeAllowedPrompt = z.infer<typeof ExitPlanModeAllowedPromptSchema>;

// plan file 需要保存最终批准的原始字符串；空白校验只看 trim 后内容，不在 schema transform 阶段改写 plan。
const ExitPlanModePlanSchema = z
  .string()
  .min(1)
  .max(PLAN_MODE_MAX_PLAN_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "String must contain at least 1 character(s)",
  })
  .describe("The implementation plan to present to the user for approval.");

export const ExitPlanModeInputSchema = z
  .object({
    plan: ExitPlanModePlanSchema,
    allowedPrompts: z
      .array(ExitPlanModeAllowedPromptSchema)
      .optional()
      .describe(
        "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      ),
    // 非模型产出字段：批准确认窗上用户指定的执行模型经 broker 的 modify 决策合并进输入
    // （模型从不主动填写；JSON Schema 不声明它，模型侧不可见）。handler 透传到输出。
    executionModelSelection: ExecutionModelSelectionSchema.optional(),
  })
  .catchall(z.unknown());
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;
export const ExitPlanModeInputJsonSchema = toToolJsonSchema(ExitPlanModeInputSchema);

export const ExitPlanModeOutputSchema = z
  .object({
    plan: z.string().nullable().describe("The plan that was approved by the user."),
    approved: z.literal(true).describe("True when the user approved exiting plan mode."),
    previousMode: z
      .enum([
        "plan",
        "build",
        "edit",
        "yolo",
        "auto",
        "research",
        "workflow",
        "minimal",
        "zcodeUpdate",
      ])
      .describe("Previous permission mode."),
    planEnabled: z.boolean().optional(),
    previousPlanEnabled: z.boolean().optional(),
    mode: z
      .enum(["build", "edit", "yolo", "auto", "research", "workflow", "minimal", "zcodeUpdate"])
      .describe("Current session mode after exiting plan mode."),
    allowedPrompts: z.array(ExitPlanModeAllowedPromptSchema).optional(),
    // 批准确认窗上用户指定的执行模型；缺省 = 跟随会话模型（同回合继续，现行行为）。
    executionModelSelection: ExecutionModelSelectionSchema.optional(),
  })
  .strict();
export type ExitPlanModeOutput = z.infer<typeof ExitPlanModeOutputSchema>;
export const ExitPlanModeOutputJsonSchema = toToolJsonSchema(ExitPlanModeOutputSchema);

export interface SessionModeTransitionInput {
  toolCallId?: string;
  traceContext?: TraceContext;
}

export interface EnterPlanModeTransitionResult {
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
}

export interface ExitPlanModeTransitionResult {
  mode: Exclude<CollaborationMode, "plan">;
  previousMode: CollaborationMode;
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
}

export interface SessionModePort {
  supportsPermissionFullAccess?(): boolean;
  isPlanEnabled?(): boolean;
  getMode(): CollaborationMode;
  getPrePlanMode(): Exclude<CollaborationMode, "plan"> | undefined;
  enterPlanMode(input?: SessionModeTransitionInput): Promise<EnterPlanModeTransitionResult>;
  exitPlanMode(input?: SessionModeTransitionInput): Promise<ExitPlanModeTransitionResult>;
}

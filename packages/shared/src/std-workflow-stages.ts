// ── 项目开发模式（workflow mode）的阶段模型 ─────────────────────────
//
// workflow 模式（apps/zcode-cli/packages/core 的 WORKFLOW_MODE_FULL_REMINDER）要求助手
// 在 `workflow/工作台账.md` 维护一条机器标记行：
//
//     <!-- std-workflow v1 stage:W2-F -->
//
// 本模块是这条约定的唯一解析点：桌面端「项目开发模式」阶段侧栏读台账后用这里推导
// 阶段条三态。标记格式演进时升 v2 并在这里兼容读取，不要在别处散落正则。
//
// 阶段编号是《项目开发标准工作流》的骨架：主线（W0/W0.5/W5…W11）+ 双轨并行段
// （前端轨 -F / 后端轨 -B）。双轨彼此并行、与主线无全序关系，所以状态推导只做
// 「同泳道内比先后」+「主线跨过 W5 视为双轨已收尾」两条保守规则——面板是可视化
// 提示，不承担调度语义，拿不准的一律显示 pending。

/** 台账的规范路径（相对工作区根）。 */
export const STD_WORKFLOW_LEDGER_RELATIVE_PATH = "workflow/工作台账.md";

/** 标记行的当前格式版本。 */
export const STD_WORKFLOW_STAGE_MARKER_VERSION = 1;

// g 标志是取「最后一次匹配」的前提：没有它 exec 永远停在第一个匹配（下面那个循环
// 就成了死循环）。lastIndex 的复位由解析函数自己负责，别处不要复用这条正则的执行状态。
const STD_WORKFLOW_STAGE_PATTERN = /<!--\s*std-workflow v(\d+) stage:([A-Za-z0-9._-]+?)\s*-->/gu;

/** 主线阶段（按序）。 */
export const STD_WORKFLOW_MAIN_STAGES = [
  "W0",
  "W0.5",
  "W5",
  "W6",
  "W7",
  "W8",
  "W9",
  "W10",
  "W11",
] as const;

/** 前端轨阶段（按序，与后端轨并行）。 */
export const STD_WORKFLOW_FRONTEND_STAGES = ["W1-F", "W2-F", "W3-F", "W4-F"] as const;

/** 后端轨阶段（按序，与前端轨并行）。 */
export const STD_WORKFLOW_BACKEND_STAGES = ["W1-B", "W2-B"] as const;

/** 对抗轮阶段 → 自动运行的 saved 工作流名（与 reminder 中的指引成对维护）。 */
export const STD_WORKFLOW_ADVERSARIAL_WORKFLOWS: Readonly<Record<string, string>> = {
  "W3-F": "wf-fe-acceptance",
  W6: "wf-adversarial-audit",
  W8: "wf-adversarial-audit",
  W10: "wf-adversarial-audit",
};

export type StdWorkflowStage =
  | (typeof STD_WORKFLOW_MAIN_STAGES)[number]
  | (typeof STD_WORKFLOW_FRONTEND_STAGES)[number]
  | (typeof STD_WORKFLOW_BACKEND_STAGES)[number];

type StdWorkflowLane = "main" | "frontend" | "backend";

function laneOf(stage: string): { lane: StdWorkflowLane; index: number } | null {
  const mainIndex = (STD_WORKFLOW_MAIN_STAGES as readonly string[]).indexOf(stage);
  if (mainIndex >= 0) return { lane: "main", index: mainIndex };
  const frontendIndex = (STD_WORKFLOW_FRONTEND_STAGES as readonly string[]).indexOf(stage);
  if (frontendIndex >= 0) return { lane: "frontend", index: frontendIndex };
  const backendIndex = (STD_WORKFLOW_BACKEND_STAGES as readonly string[]).indexOf(stage);
  if (backendIndex >= 0) return { lane: "backend", index: backendIndex };
  return null;
}

/**
 * 台账文本 → 机器标记解析结果；无标记、版本号不是当前支持的版本、或 stage 为空时返回
 * null（面板降级为纯渲染，绝不按错误版本的字段猜测）。
 *
 * 取**最后一次**匹配而不是第一次：标记行是被反复改写的"活"行，而台账开头常出现示例/
 * 模板行（wf-start 生成的模板自身就含一个示例标记）——末次匹配在两类行并存时更可能
 * 命中真正被维护的那条。
 */
export function parseStdWorkflowStageMarker(text: string): {
  version: number;
  stage: string;
} | null {
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  STD_WORKFLOW_STAGE_PATTERN.lastIndex = 0;
  while ((match = STD_WORKFLOW_STAGE_PATTERN.exec(text)) !== null) {
    last = match;
  }
  STD_WORKFLOW_STAGE_PATTERN.lastIndex = 0;
  if (!last) return null;
  const version = Number.parseInt(last[1]!, 10);
  // 只认当前版本：未来的 v2 标记格式未知，按 v1 规则推导比诚实说"没认出"更糟。
  if (!Number.isFinite(version) || version !== STD_WORKFLOW_STAGE_MARKER_VERSION) return null;
  return { version, stage: last[2]! };
}

export type StdWorkflowStageState = "done" | "current" | "pending";

export interface StdWorkflowStageStrip {
  /** 标记里的原始 stage 值；不在已知集合时 known=false，三行条不做推断。 */
  stage: string;
  known: boolean;
  main: ReadonlyArray<{ stage: string; state: StdWorkflowStageState }>;
  frontend: ReadonlyArray<{ stage: string; state: StdWorkflowStageState }>;
  backend: ReadonlyArray<{ stage: string; state: StdWorkflowStageState }>;
  /** 当前阶段本身就是对抗轮（正在进行）时的轮次信息。 */
  adversarialInProgress: { stage: string; workflow: string } | undefined;
  /** 下一个**尚未到达**的对抗轮；当前正在对抗轮、或已全部到达过时为 undefined。 */
  nextAdversarial: { stage: string; workflow: string } | undefined;
}

/**
 * 由当前阶段推导三行阶段条。保守规则：
 * - 同泳道内早于当前的记 done、晚于的记 pending、当前记 current；
 * - 当前在双轨时：主线 W0/W0.5 记 done、W5 起记 pending，另一条轨不做推断（pending）；
 * - 当前在主线时：跨过 W5（含）才把双轨整体记 done（联调意味着双轨收尾），否则 pending；
 * - 对抗轮：当前阶段本身是对抗轮时由 adversarialInProgress 表达（正在打）；
 *   nextAdversarial 只取严格晚于当前的轮次，主线按 W6→W8→W10，主线未到 W5 或双轨
 *   当前（前端轨已到达/越过 W3-F 的情形除外）保守取 W3-F。
 */
export function deriveStdWorkflowStageStrip(stage: string): StdWorkflowStageStrip {
  const current = laneOf(stage);
  if (!current) {
    const pendingMain = STD_WORKFLOW_MAIN_STAGES.map((candidate) => ({
      stage: candidate,
      state: "pending" as const,
    }));
    const pendingFrontend = STD_WORKFLOW_FRONTEND_STAGES.map((candidate) => ({
      stage: candidate,
      state: "pending" as const,
    }));
    const pendingBackend = STD_WORKFLOW_BACKEND_STAGES.map((candidate) => ({
      stage: candidate,
      state: "pending" as const,
    }));
    return {
      stage,
      known: false,
      main: pendingMain,
      frontend: pendingFrontend,
      backend: pendingBackend,
      // 未知阶段不做任何推断——nextAdversarial 也一并缺席，否则「以下不做先后推断」
      // 的横幅下面紧跟一条具体的对抗轮推断，自相矛盾。
      adversarialInProgress: undefined,
      nextAdversarial: undefined,
    };
  }

  const markLane = (stages: readonly string[], lane: StdWorkflowLane) =>
    stages.map((candidate) => {
      const position = laneOf(candidate)!;
      if (lane === "main" && current.lane !== "main") {
        // 双轨夹在 W0.5 与 W5 之间：主线只判定这两个端点。
        return {
          stage: candidate,
          state: (position.index <= 1 ? "done" : "pending") as StdWorkflowStageState,
        };
      }
      if (lane !== "main" && current.lane === "main") {
        // 主线到达 W5 及以后视为双轨收尾；否则不做跨轨推断。
        const mainReachedIntegration = current.index >= 2;
        return {
          stage: candidate,
          state: (mainReachedIntegration ? "done" : "pending") as StdWorkflowStageState,
        };
      }
      if (lane !== current.lane) {
        // 双轨之间互不推断。
        return { stage: candidate, state: "pending" as StdWorkflowStageState };
      }
      return {
        stage: candidate,
        state: (position.index === current.index ? "current" : position.index < current.index
          ? "done"
          : "pending") as StdWorkflowStageState,
      };
    });

  // 对抗轮口径：nextAdversarial 只取**严格晚于**当前的轮次（当前正处于对抗轮时由
  // adversarialInProgress 表达"正在打"），面板两类话术分开，不会出现"下一个对抗轮=当前阶段"。
  const adversarialInProgress = STD_WORKFLOW_ADVERSARIAL_WORKFLOWS[stage]
    ? { stage, workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS[stage]! }
    : undefined;
  let nextAdversarial: { stage: string; workflow: string } | undefined;
  if (current.lane === "main") {
    if (current.index < 2) {
      nextAdversarial = {
        stage: "W3-F",
        workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W3-F"]!,
      };
    } else {
      for (const adversarialStage of ["W6", "W8", "W10"] as const) {
        if (laneOf(adversarialStage)!.index > current.index) {
          nextAdversarial = {
            stage: adversarialStage,
            workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS[adversarialStage]!,
          };
          break;
        }
      }
    }
  } else {
    // 双轨当前：主线对抗轮必未到。前端轨是否已过 W3-F 无法从后端/当前轨判定，
    // 只有当前就在前端轨且已到达/越过 W3-F 时才推进到 W6——否则保守回到 W3-F
    //（无法证明前端验收已过去时不跳过它）。
    const adversarialFrontendIndex = laneOf("W3-F")!.index;
    if (current.lane === "frontend" && current.index >= adversarialFrontendIndex) {
      nextAdversarial = { stage: "W6", workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W6"]! };
    } else {
      nextAdversarial = {
        stage: "W3-F",
        workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W3-F"]!,
      };
    }
  }

  return {
    stage,
    known: true,
    adversarialInProgress,
    main: markLane(STD_WORKFLOW_MAIN_STAGES, "main"),
    frontend: markLane(STD_WORKFLOW_FRONTEND_STAGES, "frontend"),
    backend: markLane(STD_WORKFLOW_BACKEND_STAGES, "backend"),
    nextAdversarial,
  };
}

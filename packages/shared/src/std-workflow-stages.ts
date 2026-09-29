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

const STD_WORKFLOW_STAGE_PATTERN = /<!--\s*std-workflow v(\d+) stage:([A-Za-z0-9._-]+?)\s*-->/u;

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

/** 台账文本 → 机器标记解析结果；无标记或版本不识别时返回 null（面板降级为纯渲染）。 */
export function parseStdWorkflowStageMarker(text: string): {
  version: number;
  stage: string;
} | null {
  const match = STD_WORKFLOW_STAGE_PATTERN.exec(text);
  if (!match) return null;
  const version = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(version)) return null;
  return { version, stage: match[2]! };
}

export type StdWorkflowStageState = "done" | "current" | "pending";

export interface StdWorkflowStageStrip {
  /** 标记里的原始 stage 值；不在已知集合时 known=false，三行条不做推断。 */
  stage: string;
  known: boolean;
  main: ReadonlyArray<{ stage: string; state: StdWorkflowStageState }>;
  frontend: ReadonlyArray<{ stage: string; state: StdWorkflowStageState }>;
  backend: ReadonlyArray<{ stage: string; state: StdWorkflowStageState }>;
  /** 下一个未过去的对抗轮；推不出（很少见）或已全部过去时为 undefined。 */
  nextAdversarial: { stage: string; workflow: string } | undefined;
}

/**
 * 由当前阶段推导三行阶段条。保守规则：
 * - 同泳道内早于当前的记 done、晚于的记 pending、当前记 current；
 * - 当前在双轨时：主线 W0/W0.5 记 done、W5 起记 pending，另一条轨不做推断（pending）；
 * - 当前在主线时：跨过 W5（含）才把双轨整体记 done（联调意味着双轨收尾），否则 pending；
 * - 下一对抗轮：主线按 W6→W8→W10 顺序取第一个晚于当前的；当前在双轨或主线未到 W5
 *   时取 W3-F（无法证明前端验收已过去时不跳过它）。
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
      nextAdversarial: {
        stage: "W3-F",
        workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W3-F"]!,
      },
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
    // 双轨当前：主线对抗轮必未到，前端轨是否已过 W3-F 无法从后端/当前轨判定，
    // 统一回到最早的 W3-F，除非当前就是主线之外已过去的位置（W4-F 之后仍取 W3-F
    // 会误导，这里只在当前为前端轨且已越过 W3-F 时才推进到 W6）。
    const adversarialFrontendIndex = laneOf("W3-F")!.index;
    if (current.lane === "frontend" && current.index > adversarialFrontendIndex) {
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
    main: markLane(STD_WORKFLOW_MAIN_STAGES, "main"),
    frontend: markLane(STD_WORKFLOW_FRONTEND_STAGES, "frontend"),
    backend: markLane(STD_WORKFLOW_BACKEND_STAGES, "backend"),
    nextAdversarial,
  };
}

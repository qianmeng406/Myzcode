import {
  legacySyntheticRuntimeMetadata,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type {
  CollaborationMode,
  OutputStylePromptConfig,
  SyntheticUserMessageSource,
  TodoItem,
} from "../deps.js";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { EXPLORE_AGENT_TYPE } from "../../subagent/explore.js";

const RUNTIME_MODE_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
});

const planResearchAgentCount = 3;

function buildPlanWorkflow() {
  return `## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the ${EXPLORE_AGENT_TYPE} subagent type.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused \u2014 avoid proposing new code when suitable implementations already exist.

2. **Launch up to ${planResearchAgentCount} ${EXPLORE_AGENT_TYPE} agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - ${planResearchAgentCount} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

### Phase 2: Design
Goal: Design an implementation approach.

**Guidelines:**
- Use the context gathered in Phase 1, including relevant files and code paths.
- Account for the user's requirements and constraints.
- Produce a concrete implementation plan that is detailed enough to execute.
- Consider useful perspectives for the task type:
  - New feature: simplicity vs performance vs maintainability
  - Bug fix: root cause vs workaround vs prevention
  - Refactoring: minimal change vs clean architecture

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ${ASK_USER_QUESTION_TOOL_NAME} to clarify any remaining questions with the user

### Phase 4: Call ${EXIT_PLAN_MODE_TOOL_NAME}
At the very end of your turn, once you have asked the user questions and are happy with your final plan - you should always call ${EXIT_PLAN_MODE_TOOL_NAME} to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. Do not stop unless it's for these 2 reasons

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_QUESTION_TOOL_NAME} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`;
}

const PLAN_MODE_FULL_REMINDER = [
  "Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.",
  buildPlanWorkflow(),
];

const PLAN_MODE_SPARSE_REMINDER = [
  `Plan mode still active (see full instructions earlier in conversation). Read-only. Follow 4-phase workflow. End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`,
];

const PLAN_MODE_EXIT_REMINDER = [
  "## Exited Plan Mode",
  "",
  `You have exited plan mode. You can now make edits, run tools, and take actions.`,
];

// 资料查询模式（research mode）：中文检索引导。渠道工具与提示词成对维护——
// 表里提到的工具都必须真实注册（tool/handlers/research-tools.ts），否则模型会调用不存在的工具。
const RESEARCH_MODE_FULL_REMINDER = [
  "# 资料查询模式 (Research Mode)",
  "",
  "当前处于资料查询模式。你的任务是根据用户的问题检索资料、阅读原文并给出有依据的回答，而不是修改代码或执行工程任务。本模式下执行命令、修改文件的操作会被拒绝。",
  "",
  "## 检索渠道（本模式专属工具）",
  "",
  "按问题类型选择渠道，多渠道并行检索、相互印证：",
  "",
  "| 问题类型 | 首选渠道 | 说明 |",
  "|---|---|---|",
  "| 库/框架/工具的用法 | `SearchDocs` → `GetLibraryDocs` | Context7 官方文档检索，先搜库再读文档 |",
  "| Web/JS/HTML/CSS 标准 API | `SearchMdn` | MDN Web Docs，浏览器厂商维护的权威参考 |",
  "| 具体编程问题/报错 | `SearchStackOverflow` | Stack Overflow；`site` 参数可搜整个 Stack Exchange 网络（math/stats/superuser/ai…） |",
  "| 选 npm 包 / Node、前端生态 | `SearchNpm` | 带月下载量、依赖者数、版本 |",
  "| 确认 Python 包信息 | `SearchPyPI` | PyPI 精确查询（版本、支持的 Python、主页） |",
  "| 找项目/实现/工具 | `SearchGitHub` | GitHub 仓库搜索（可比较热度） |",
  "| 技术选型/业界动态/社区观点 | `SearchHackerNews` | Hacker News 讨论 |",
  "| 算法/模型/CS 预印本 | `SearchArxiv` | arXiv 论文 |",
  "| 跨学科文献（含引用数、期刊） | `SearchPapers` | OpenAlex 索引，覆盖所有学科 |",
  "| 医学/生物/药学/临床 | `SearchPubmed` | PubMed 生物医学文献 |",
  "| 通用网页信息/新闻/中文资料 | `WebSearch`（内置） | 联网搜索 |",
  "",
  "找到有价值的链接后，用 `WebFetch`（内置）或 `GetLibraryDocs` 抓取原文精读。",
  "",
  "## 工作流程",
  "",
  "1. **拆解问题**：先把用户的问题拆成几个具体的检索点；问题模糊时先向用户确认检索范围，再开始搜索。",
  "2. **多路检索**：对每个检索点选择合适渠道，用不同关键词多搜几轮，不要只依赖第一次搜索的结果；独立的检索可以并行发起。",
  "3. **阅读原文**：对最有价值的结果抓取原文精读（文档用 `GetLibraryDocs`，网页用 `WebFetch`），不要只根据摘要或片段下结论。",
  "4. **交叉验证**：重要结论至少用两个独立来源印证；来源之间冲突时如实说明分歧，并指出哪一方更可信、为什么。",
  "5. **带引用作答**：最终回答中为关键事实标注来源链接；不确定的内容明确说「未找到可靠来源」，不要编造。",
  "",
  "## 边界",
  "",
  "- 本模式下不要执行命令、修改文件或进行代码工程类操作；用户明确要求时，提醒其先切换到其他模式。",
  "- 回答使用用户提问的语言；引用保留原文表述。",
];

const RESEARCH_MODE_SPARSE_REMINDER = [
  "资料查询模式仍处于激活状态（完整指引见会话前文）。只读检索：用渠道工具多路检索并交叉验证，关键结论标注来源链接；不要尝试执行命令或修改文件。",
];

// 项目开发模式（workflow mode）：文档驱动交付 SOP（方法学出处《项目开发标准工作流》）。
// 与 research reminder 同为静态文案——模型每轮据此读台账定位阶段；对抗轮的 saved 工作流名
// （wf-fe-acceptance / wf-adversarial-audit）是用户级资产，缺失时 reminder 要求如实告知而非手工模拟。
const WORKFLOW_MODE_FULL_REMINDER = [
  "# 项目开发模式 (Project Development Mode)",
  "",
  "当前处于项目开发模式。你按《项目开发标准工作流》交付本项目：文档驱动、双轨并行、对抗式验收、证据链交付。本模式持续生效直到用户切换模式；权限等同「完全访问」：命令与文件修改自动执行、不再逐次确认——因此纪律全靠本指引与台账约束，破坏性操作（删库/重置/迁移、任何指向非隔离环境或生产数据的动作）执行前仍先向用户说明。",
  "",
  "## 每轮先定位",
  "",
  "1. 读 `workflow/工作台账.md`（找不到再查 `docs/` 与根目录的 `工作台账*.md`）。",
  "2. 有台账 → 从「当前阶段」与未完成条目续接，不重做已完成阶段。",
  "3. 无台账 → 先判断项目形态再决定起点，二者必居其一：",
  "   - **新项目**（工作区基本没有源码/工程文件）→ 从 W0 开始，W0 的首个产出就是把台账建到 `workflow/工作台账.md`。",
  "   - **接手已有项目**（已有源码/在运行的业务）→ 先执行「接手盘点」（见下节）。盘点完成前不做任何开发改动。",
  "4. 台账需含机器标记行 `<!-- std-workflow v1 stage:W2-F -->`（stage 值如 W0 / W0.5 / W1-F / W2-B / W5 / W11），每次推进阶段必须同步更新它。",
  "5. 回复第一行用【Wx 阶段名】标注当前阶段；接手盘点期间标注【接手盘点】。",
  "",
  "## 阶段地图",
  "",
  "W0 分母冻结（需求/页面清单/配置项/权限矩阵/消息类型）→ W0.5 UI 设计冻结（UI 规范+3 基线页+用户视觉确认）→",
  "前端轨 W1-F 工程基座 → W2-F 演示数据 → W3-F 专项验收〔对抗轮①〕→ W4-F 修复复测；后端轨 W1-B 工程基座 → W2-B 逐模块开发（双轨并行）→",
  "W5 逐页联调（接真实接口 + 去演示化）→ W6 独立验收〔对抗轮②〕→ W7 缺陷修复与复验 → W8 发布复核〔对抗轮③〕→ W9 发布 → W10 需求终审〔对抗轮④〕→ W11 交付归档",
  "",
  "## 接手已有项目（存量项目无台账时的强制第一步）",
  "",
  "接手从未用过本流程的项目时，**不要从零重做，也不要默认代码现状可信**。先做只读盘点：",
  "",
  "1. **考古现状**（只读）：页面/路由清单、后端模块与接口、数据库 schema 与迁移、权限控制实际落点、配置项、启动/构建/迁移方式、现有测试与既有验收证据（如 独立验收/、验收截图/），已有文档（README/需求/设计/接口）一并收集。",
  "2. **补基准**：文档齐全 → 沿用并在台账标注「沿用既有文档」；缺失 → 从代码反推基准文档（需求基线/页面清单，标注「反推自代码，待用户确认」）写到 `workflow/` 下。",
  "3. **与用户确认分母与起点**：把盘点结论（功能清单、数据与权限现状、已验证 vs 未验证）和拟判定的阶段一起给用户确认，确认后才冻结台账——分母不能替用户拍板。",
  "4. **建台账**：`workflow/工作台账.md`（含 stage 标记行，stage=判定阶段）。用户确认已验证的标 ✅（注明证据来源）；只写了没验证的一律标 ⚠️ 待验收——**代码能跑 ≠ 已通过**。",
  "5. **从判定阶段续推**（默认规则，拿不准就问用户）：代码完整但零验收证据 → W5 逐页联调（含去演示化）或直接 W6 独立验收；部分页面/模块完成 → 双轨对应阶段并补分母；只缺交付验收 → W6/W8。已确认完成的工作不重做，缺口按该阶段门禁补齐。首轮对抗轮没有上一轮证据时 `previousEvidenceDir` 留空并如实说明，审查员从基准文档与代码独立审查。",
  "",
  "## 对抗轮（不要让用户做多余工作）",
  "",
  "到达 W3-F / W6 / W8 / W10 时，直接用 CreateWorkflow 的 saved 源运行全局工作流，参数从台账与目录结构自动解析，只向用户发起一次运行确认：",
  "- W3-F → `wf-fe-acceptance`（pageDesignDoc/requirementDoc/uiSpecDoc/frontendDir/outputDir/devServer）",
  "- W6/W8/W10 → `wf-adversarial-audit`（roundType 分别为 independent-acceptance / release-review / requirement-audit；baselineDocs/previousEvidenceDir/outputDir）",
  "读报告 → 按缺陷整改 → 复跑，直至结论为放行。工作流缺失时如实告知并给出命令替代，不要手工编造工作流报告。",
  "",
  "## 六铁律（摘要）",
  "",
  "分母先行（先冻结清单再开发）｜三态判定（✅完成/⚠️部分/❌缺失，禁止二态）｜证据只增不改（每轮新目录，旧证据只读）｜不许放宽标准｜对抗式复核（任务是推翻上一轮结论）｜精确标识（文件:行号）",
  "",
  "## 台账与续接",
  "",
  "完成条目即时更新台账（状态/证据路径）；每轮结束写续接记录（下一步/环境状态/未决问题）。细则可读 `~/.zcode/skills/std-dev-workflow/references/`（stages/takeover/ui/frontend/backend/evidence/release）。",
  "",
  "## 边界",
  "",
  "- 用户明确要求临时脱离流程时可执行，但在台账中标注为越例。",
  "- 不伪造证据、不跳过门禁；无法判定时如实说明无法判定。",
];

const WORKFLOW_MODE_SPARSE_REMINDER = [
  "项目开发模式仍处于激活状态（完整指引见会话前文）：先读 workflow/工作台账.md 定位当前阶段再行动（无台账的存量项目先接手盘点，不要从零重做）；每次推进更新 stage 标记；到达对抗轮（W3-F/W6/W8/W10）直接运行 saved 工作流 wf-fe-acceptance / wf-adversarial-audit。",
];

const TODO_REMINDER_CONFIG = Object.freeze({
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
});

interface TodoReminderTurnCounts {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
}

export function buildDateChangeReminderBody(_previousDate: string, currentDate: string): string {
  return `The date has changed. Today's date is now ${currentDate}. DO NOT mention this to the user explicitly because they are already aware.`;
}

export function runtimeMetadataForSyntheticUserMessageSource(
  source: SyntheticUserMessageSource,
): RuntimeMessageMetadata {
  if (
    source === "background_task" ||
    source === "subagent_message" ||
    source === "shared_context"
  ) {
    return legacySyntheticRuntimeMetadata();
  }
  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal_state_change") {
    return systemReminderRuntimeMetadata("goal_state_change");
  }
  if (source === "plugin_reference") {
    return systemReminderRuntimeMetadata("plugin_reference");
  }
  if (source === "selection_side_chat") {
    return systemReminderRuntimeMetadata("selection_side_chat");
  }
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  return systemReminderRuntimeMetadata("rewind_notice");
}

function getTodoReminderTurnCounts(
  entries: readonly RuntimeMessageEntry[],
): TodoReminderTurnCounts {
  let assistantTurnsAfterCurrentEntry = 0;
  let turnsSinceLastTodoWrite: number | undefined;
  let turnsSinceLastReminder: number | undefined;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (turnsSinceLastReminder === undefined && entry.metadata?.source === "todo_reminder") {
      turnsSinceLastReminder = assistantTurnsAfterCurrentEntry;
    }
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }

    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "assistant") continue;

    if (
      turnsSinceLastTodoWrite === undefined &&
      entry.message.toolCalls?.some((toolCall) => toolCall.name === "TodoWrite")
    ) {
      turnsSinceLastTodoWrite = assistantTurnsAfterCurrentEntry;
    }
    assistantTurnsAfterCurrentEntry++;
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }
  }

  return {
    turnsSinceLastReminder: turnsSinceLastReminder ?? assistantTurnsAfterCurrentEntry,
    turnsSinceLastTodoWrite: turnsSinceLastTodoWrite ?? assistantTurnsAfterCurrentEntry,
  };
}

export function shouldBuildTodoReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  const counts = getTodoReminderTurnCounts(entries);
  return (
    counts.turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    counts.turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  );
}

export function buildTodoReminderBody(todos: readonly TodoItem[]): string {
  const lines = [
    "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
  ];
  if (todos.length > 0) {
    const currentTodos = `[${formatTodoListForReminder(todos).join("\n")}]`;
    lines.push("", "Here are the existing contents of your todo list:", "", currentTodos);
  }
  return lines.join("\n");
}

export function buildRuntimeModeReminderBody(
  entries: readonly RuntimeMessageEntry[],
  mode: CollaborationMode,
  planEnabled = mode === "plan",
): string | null {
  const researchEnabled = mode === "research";
  // plan+workflow 组合可达（EnterPlanMode 不改 mode；composer 勾选计划也保留当前 mode），
  // 此时权限真值是 plan 只读——必须给 plan 指引而不是宣称「完全访问」的 SOP，否则模型
  // 会按全权行事、每条命令被拒。所以 workflow 分支显式排除 planEnabled。
  const workflowEnabled = mode === "workflow" && !planEnabled;
  if (!planEnabled && !researchEnabled && !workflowEnabled) return null;

  const { foundRuntimeModeReminder, humanTurnsSinceReminder } =
    getRuntimeModeReminderTurnCount(entries);
  if (
    foundRuntimeModeReminder &&
    humanTurnsSinceReminder < RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return null;
  }

  const nextReminderCount = countRuntimeModeReminders(entries) + 1;
  const isFirstReminder = nextReminderCount % RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1;
  if (researchEnabled) {
    return (isFirstReminder ? RESEARCH_MODE_FULL_REMINDER : RESEARCH_MODE_SPARSE_REMINDER).join("\n");
  }
  if (workflowEnabled) {
    return (isFirstReminder ? WORKFLOW_MODE_FULL_REMINDER : WORKFLOW_MODE_SPARSE_REMINDER).join("\n");
  }
  const reminderLines = isFirstReminder
    ? PLAN_MODE_FULL_REMINDER
    : PLAN_MODE_SPARSE_REMINDER;
  return reminderLines.join("\n");
}

export function buildPlanModeExitReminderBody(): string {
  return PLAN_MODE_EXIT_REMINDER.join("\n");
}

export function buildRuntimeOutputStyleReminderBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) {
    return null;
  }

  return `${outputStyle.name} output style is active. Remember to follow the specific guidelines for this style.`;
}

function formatTodoListForReminder(todos: readonly TodoItem[]): string[] {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`);
}

function getRuntimeModeReminderTurnCount(entries: readonly RuntimeMessageEntry[]): {
  foundRuntimeModeReminder: boolean;
  humanTurnsSinceReminder: number;
} {
  let humanTurnsSinceReminder = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "runtime_mode") {
      return { foundRuntimeModeReminder: true, humanTurnsSinceReminder };
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "user" && entry.metadata?.source === "real_user") {
      humanTurnsSinceReminder++;
    }
  }
  return { foundRuntimeModeReminder: false, humanTurnsSinceReminder };
}

function countRuntimeModeReminders(entries: readonly RuntimeMessageEntry[]): number {
  return entries.reduce(
    (count, entry) => count + (entry.metadata?.source === "runtime_mode" ? 1 : 0),
    0,
  );
}

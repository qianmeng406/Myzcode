// 待处理交互卡：官方 mqt（权限/选项/自由文本/多题/计划批准）的卡片语言——
// rounded-lg border bg-card + 标题 + 选项按钮组（primary 白底 / secondary 描边）。
// 敏感输入只在内存；conversation.tsx 只留命令提交。
import { useState } from "react";
import { buildElicitationAnswer, type MobileInteraction } from "./conversationState.js";

export function InteractionCard(props: {
  interaction: MobileInteraction;
  disabled: boolean;
  onAnswer: (
    interactionId: string,
    answer: {
      optionId?: string;
      freeText?: string;
      action?: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    },
  ) => Promise<void>;
}): React.ReactElement {
  const { interaction } = props;
  const [text, setText] = useState("");
  // 多题选择草稿：question 文本 → 已选 value 列表（仅内存）。
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const textApplies = interaction.freeText || interaction.sensitive;
  const hasQuestions = interaction.questions.length > 0;

  const answerWith = (answer: {
    optionId?: string;
    freeText?: string;
    action?: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  }): Promise<void> => {
    void props.onAnswer(interaction.interactionId, answer);
    return Promise.resolve();
  };

  const toggleOption = (questionText: string, value: string, multiSelect: boolean): void => {
    setSelections((previous) => {
      const current = previous[questionText] ?? [];
      const next = multiSelect
        ? current.includes(value)
          ? current.filter((entry) => entry !== value)
          : [...current, value]
        : current.includes(value)
          ? []
          : [value];
      return { ...previous, [questionText]: next };
    });
  };

  if (hasQuestions) {
    const plan = interaction.isPlanApproval;
    return (
      <div className="interaction-card">
        <div className="ic-title">
          <span className="row-kind">{plan ? "计划批准" : interaction.kind}</span>
          {interaction.prompt}
        </div>
        {interaction.questions.map((question) => (
          <div key={question.question}>
            {question.header !== "" && <div className="ic-body">{question.header}</div>}
            <div className="ic-actions">
              {question.options.map((option) => {
                const selected = (selections[question.question] ?? []).includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    className="btn-secondary"
                    disabled={props.disabled}
                    style={selected ? { outline: "2px solid var(--foreground-subtle)" } : undefined}
                    onClick={() => toggleOption(question.question, option.value, question.multiSelect)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="ic-actions">
          {plan ? (
            <>
              <button
                type="button"
                className="btn-primary"
                disabled={props.disabled}
                onClick={() => void answerWith(buildElicitationAnswer(interaction.questions, selections))}
              >
                批准
              </button>
              <button
                type="button"
                className="btn-secondary danger"
                disabled={props.disabled}
                onClick={() => void answerWith({ action: "decline", content: {} })}
              >
                拒绝
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={props.disabled}
              onClick={() => void answerWith(buildElicitationAnswer(interaction.questions, selections))}
            >
              提交
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="interaction-card">
      <div className="ic-title">
        <span className="row-kind">{interaction.kind}</span>
        {interaction.prompt}
      </div>
      {textApplies && (
        <div className="ic-text-row">
          <input
            className="ic-input"
            type={interaction.sensitive ? "password" : "text"}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={interaction.sensitive ? "输入敏感信息（不保存）" : "输入回答…"}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={props.disabled || text.trim() === ""}
            onClick={() => void answerWith({ freeText: text.trim() })}
          >
            发送
          </button>
        </div>
      )}
      <div className="ic-actions">
        {interaction.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className="btn-secondary"
            disabled={props.disabled}
            onClick={() =>
              void answerWith({
                optionId: option.optionId,
                // permission 的自由文本是伴随反馈：选选项时一并携带。
                ...(interaction.kind === "permission" && text.trim() !== ""
                  ? { freeText: text.trim() }
                  : {}),
              })
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

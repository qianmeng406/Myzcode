// 待处理交互卡：选项回答 + 自由文本/敏感输入（仅内存草稿）+ 多题/计划批准。
// 独立模块原因：架构门禁单文件 400 行上限；conversation.tsx 只留命令提交。
import { useState } from "react";
import {
  buildElicitationAnswer,
  type MobileInteraction,
} from "./conversationState.js";

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
      <div className="row">
        <div className="kind">{plan ? "计划批准" : interaction.kind}</div>
        {interaction.prompt}
        {interaction.questions.map((question) => (
          <div key={question.question} style={{ marginTop: 6 }}>
            {question.header !== "" && (
              <div className="kind" style={{ marginTop: 4 }}>
                {question.header}
              </div>
            )}
            <div className="answer">
              {question.options.map((option) => {
                const selected = (selections[question.question] ?? []).includes(option.value);
                return (
                  <button
                    key={option.value}
                    className="button secondary"
                    disabled={props.disabled}
                    style={selected ? { outline: "2px solid #4f7cff" } : undefined}
                    onClick={() => toggleOption(question.question, option.value, question.multiSelect)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="answer">
          {plan ? (
            <>
              <button
                className="button"
                disabled={props.disabled}
                onClick={() => void answerWith(buildElicitationAnswer(interaction.questions, selections))}
              >
                批准
              </button>
              <button
                className="button danger"
                disabled={props.disabled}
                onClick={() => void answerWith({ action: "decline", content: {} })}
              >
                拒绝
              </button>
            </>
          ) : (
            <button
              className="button"
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
    <div className="row">
      <div className="kind">{interaction.kind}</div>
      {interaction.prompt}
      {textApplies && (
        <div className="answer" style={{ width: "100%" }}>
          <input
            type={interaction.sensitive ? "password" : "text"}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={interaction.sensitive ? "输入敏感信息（不保存）" : "输入回答…"}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            className="button"
            disabled={props.disabled || text.trim() === ""}
            onClick={() => void answerWith({ freeText: text.trim() })}
          >
            发送
          </button>
        </div>
      )}
      <div className="answer">
        {interaction.options.map((option) => (
          <button
            key={option.optionId}
            className="button secondary"
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

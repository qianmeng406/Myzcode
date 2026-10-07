// 待处理交互卡：选项回答 + 自由文本/敏感输入（仅内存草稿）。
// 独立模块原因：架构门禁单文件 400 行上限；conversation.tsx 只留命令提交。
import { useState } from "react";
import type { MobileInteraction } from "./conversationState.js";

export function InteractionCard(props: {
  interaction: MobileInteraction;
  disabled: boolean;
  onAnswer: (interactionId: string, answer: { optionId?: string; freeText?: string }) => Promise<void>;
}): React.ReactElement {
  const { interaction } = props;
  const [text, setText] = useState("");
  const textApplies = interaction.freeText || interaction.sensitive;

  const answerWith = (answer: { optionId?: string; freeText?: string }): Promise<void> => {
    void props.onAnswer(interaction.interactionId, answer);
    return Promise.resolve();
  };

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

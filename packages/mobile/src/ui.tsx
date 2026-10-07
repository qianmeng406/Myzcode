// 官方移动端 UI 原语：图标（lucide 线条，对应官方 d5t/Xc/rl 等引用）、
// 主题系统（system/zai-dark/zai-light，官方 u5t 三态）、下拉菜单（官方 DropdownMenu 结构）。
import { useCallback, useEffect, useRef, useState } from "react";

// ── 图标（24×24 viewBox，stroke=currentColor，对应官方图标引用） ──
type IconProps = { className?: string };

function svg(paths: React.ReactNode, filled = false): (props: IconProps) => React.ReactElement {
  return function Icon({ className = "ic" }: IconProps): React.ReactElement {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill={filled ? "currentColor" : "none"}
        stroke={filled ? "none" : "currentColor"}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };
}

export const ArrowLeftIcon = svg(
  <>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </>,
);
export const SunMoonIcon = svg(
  <>
    <path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </>,
);
export const RefreshIcon = svg(
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>,
);
export const OrganizeIcon = svg(
  <>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </>,
);
export const CollapseAllIcon = svg(
  <>
    <path d="m7 20 5-5 5 5" />
    <path d="m7 4 5 5 5-5" />
  </>,
);
export const FolderIcon = svg(
  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
);
export const CloudIcon = svg(<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />);
export const MessageIcon = svg(
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
);
export const ChevronUpIcon = svg(<path d="m18 15-6-6-6 6" />);
export const ChevronDownIcon = svg(<path d="m6 9 6 6 6-6" />);
export const PlusIcon = svg(
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
);
export const CheckIcon = svg(<path d="M20 6 9 17l-5-5" />);
export const XIcon = svg(
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);
export const ArrowUpIcon = svg(
  <>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </>,
);
export const StopIcon = svg(<rect x="6" y="6" width="12" height="12" rx="2" />, true);
export const PinIcon = svg(
  <>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </>,
);

// ── 主题（官方 u5t = ['system','zai-dark','zai-light']；类名 theme-zai-*） ──

export type ThemeName = "system" | "zai-dark" | "zai-light";
const THEME_KEY = "zcode-mobile-theme";
const THEME_OPTIONS: ThemeName[] = ["system", "zai-dark", "zai-light"];

const THEME_LABELS: Record<ThemeName, string> = {
  system: "系统默认",
  "zai-dark": "深色主题",
  "zai-light": "浅色主题",
};

function resolve(theme: ThemeName): "zai-dark" | "zai-light" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "zai-dark" : "zai-light";
}

function applyThemeClass(theme: ThemeName): void {
  const resolved = resolve(theme);
  document.documentElement.classList.toggle("theme-zai-dark", resolved === "zai-dark");
  document.documentElement.classList.toggle("theme-zai-light", resolved === "zai-light");
}

export function useTheme(): {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
} {
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    return THEME_OPTIONS.includes(stored as ThemeName) ? (stored as ThemeName) : "system";
  });
  useEffect(() => {
    applyThemeClass(theme);
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => applyThemeClass("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);
  const setTheme = useCallback((next: ThemeName): void => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // 存储失败只影响跨启动记忆。
    }
  }, []);
  return { theme, setTheme };
}

// ── 菜单（官方 DropdownMenu：触发器 + 右对齐弹层 + 单选项） ──

export function Menu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: (attrs: { onClick: () => void; "aria-label": string }) => React.ReactNode;
  children: React.ReactNode;
  triggerAriaLabel: string;
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.open) return;
    const onOutside = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        props.onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [props]);
  return (
    <div className="menu-root" ref={rootRef}>
      {props.trigger({
        onClick: () => props.onOpenChange(!props.open),
        "aria-label": props.triggerAriaLabel,
      })}
      {props.open && <div className="menu-pop">{props.children}</div>}
    </div>
  );
}

export function MenuItem(props: {
  checked?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button type="button" className="menu-item" onClick={props.onClick}>
      <span className="check">{props.checked === true ? <CheckIcon className="ic sm" /> : null}</span>
      {props.children}
    </button>
  );
}

export function MenuLabel(props: { children: React.ReactNode }): React.ReactElement {
  return <div className="menu-label">{props.children}</div>;
}

/** 官方 d5t：主题菜单（Home 头部与 Chat 顶栏共用）。 */
export function ThemeMenu(props: {
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      triggerAriaLabel="选择主题"
      trigger={(attrs) => (
        <button type="button" className="iconbtn" {...attrs}>
          <SunMoonIcon />
        </button>
      )}
    >
      {THEME_OPTIONS.map((option) => (
        <MenuItem
          key={option}
          checked={option === props.theme}
          onClick={() => {
            props.onThemeChange(option);
            setOpen(false);
          }}
        >
          {THEME_LABELS[option]}
        </MenuItem>
      ))}
    </Menu>
  );
}

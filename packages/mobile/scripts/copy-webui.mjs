// 把完整 Web UI 构建产物拷入 Android assets（Capacitor webDir 的 webui/ 子路径）。
// sourcemap 不进包。用法：node scripts/copy-webui.mjs
import { cpSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(mobileDir, "..", "web", "dist");
const dest = join(mobileDir, "android", "app", "src", "main", "assets", "public", "webui");
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: (s) => !s.endsWith(".map") });
console.log("[copy-webui] copied", readdirSync(dest).length, "entries");

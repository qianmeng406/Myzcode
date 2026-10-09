// 本地调试：对 dev-stack 的 control DB 铸一枚配对码。
import { openCompanionControlAdmin } from "@zcode/companion/admin";
import { join } from "node:path";

const db = process.argv[2] ?? join(process.cwd(), ".tmp", "companion-dev-stack", "control.db");
const admin = await openCompanionControlAdmin({ controlDbPath: db });
const issued = await admin.createPairingCode();
console.log(issued.code);
await admin.close();

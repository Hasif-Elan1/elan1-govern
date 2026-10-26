import "server-only";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? (process.env.LOG_LEVEL === "silent" ? 100 : 20);

// Structured JSON lines. Pass ids, never emails, names, bodies or tokens.
export function log(level: Level, msg: string, fields: Record<string, string | number | boolean | null | undefined> = {}) {
  if (ORDER[level] < min) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: "web", msg, ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

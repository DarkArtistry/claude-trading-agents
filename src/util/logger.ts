type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

export function createLogger(level: Level, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: Level, msg: string, extra?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...bindings,
      ...extra,
    };
    const stream = lvl === "error" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(line) + "\n");
  };

  return {
    debug: (msg, extra) => emit("debug", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    error: (msg, extra) => emit("error", msg, extra),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

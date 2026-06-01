type LogLevel = "info" | "warn" | "error" | "debug";

const SENSITIVE_PATTERNS = [
  /postgresql:\/\/[^@]+@/gi,
  /password[=:]\s*\S+/gi,
  /SRI_CERT_ENCRYPTION_KEY[=:]\s*\S+/gi,
  /-----BEGIN[^-]+-----[\s\S]+?-----END[^-]+-----/g,
];

function sanitize(msg: string): string {
  let out = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const safe = sanitize(message);
  const prefix = `[${ts}] [${level.toUpperCase()}]`;

  if (meta && Object.keys(meta).length > 0) {
    const safeMeta = JSON.parse(sanitize(JSON.stringify(meta))) as Record<string, unknown>;
    if (level === "error") {
      console.error(`${prefix} ${safe}`, safeMeta);
    } else {
      console.log(`${prefix} ${safe}`, safeMeta);
    }
  } else {
    if (level === "error") {
      console.error(`${prefix} ${safe}`);
    } else {
      console.log(`${prefix} ${safe}`);
    }
  }
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
};

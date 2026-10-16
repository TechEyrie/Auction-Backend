export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const REDACTED = '[REDACTED]';

/** Key names whose values must never be logged. */
const SENSITIVE_KEY =
  /(pass(word|code|wd)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credit[-_]?card|card[-_]?number|cvv|cvc|ssn|otp|pin|session|refresh|access[-_]?token|client[-_]?secret)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogSink = { write(chunk: string): unknown };

export type Logger = {
  level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export function createLogger(level: LogLevel = 'info', sink: LogSink = process.stdout): Logger {
  const min = LEVEL_WEIGHT[level];
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[lvl] < min) return;
    const line: Record<string, unknown> = { level: lvl, time: new Date().toISOString(), msg: message };
    if (fields) {
      const safe = redact(fields);
      if (safe && typeof safe === 'object') Object.assign(line, safe as Record<string, unknown>);
    }
    sink.write(`${JSON.stringify(line)}\n`);
  };
  return {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

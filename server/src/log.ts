// 간결한 타임스탬프 로그. 비밀값(키/시크릿/메모)은 절대 넘기지 말 것.
type Level = 'INFO' | 'WARN' | 'ERROR';

function line(level: Level, msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const extra = data === undefined ? '' : ' ' + safeJson(data);
  const out = `${ts} [${level}] ${msg}${extra}`;
  if (level === 'ERROR') console.error(out);
  else if (level === 'WARN') console.warn(out);
  else console.log(out);
}

function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) return JSON.stringify({ name: v.name, message: v.message });
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  info: (msg: string, data?: unknown) => line('INFO', msg, data),
  warn: (msg: string, data?: unknown) => line('WARN', msg, data),
  error: (msg: string, data?: unknown) => line('ERROR', msg, data),
};

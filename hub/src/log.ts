export type LogLevel = 'quiet' | 'info' | 'debug';

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function stamp(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Tiny console logger. `quiet` keeps warnings and errors only; `debug` adds per-message detail. */
export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = console.log): Logger {
  const emit = (tag: string, message: string): void => sink(`${stamp()} ${tag} ${message}`);
  return {
    error: (m) => emit('ERR ', m),
    warn: (m) => emit('WARN', m),
    info: (m) => {
      if (level !== 'quiet') emit('    ', m);
    },
    debug: (m) => {
      if (level === 'debug') emit('dbg ', m);
    },
  };
}

export const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };

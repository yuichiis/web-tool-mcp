import { format } from 'node:util';

export const logger = {
  log: (...args: unknown[]) => writeLog(...args),
  warn: (...args: unknown[]) => writeLog(...args),
  error: (...args: unknown[]) => writeLog(...args),
};

function writeLog(...args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`);
}

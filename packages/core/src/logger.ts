export interface Logger {
  info(message: string): void;
  error(message: string): void;
  success(message: string): void;
}

export function createLogger(component: string): Logger {
  const pad = component.padEnd(12);
  const timestamp = () => new Date().toISOString();

  return {
    info(message: string) {
      console.log(`[${timestamp()}] [${pad}] ${message}`);
    },
    error(message: string) {
      console.error(`[${timestamp()}] [${pad}] ${message}`);
    },
    success(message: string) {
      console.log(`[${timestamp()}] [${pad}] ${message.padEnd(40)} ✓`);
    },
  };
}

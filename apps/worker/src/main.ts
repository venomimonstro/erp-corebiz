const shutdown = (signal: string): void => {
  process.stdout.write(`[worker] received ${signal}, shutting down\n`);
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.stdout.write("[worker] CoreBiz background worker started\n");

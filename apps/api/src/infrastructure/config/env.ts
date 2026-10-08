export type AppEnv = Readonly<{
  nodeEnv: "development" | "test" | "production";
  apiPort: number;
  databaseUrl: string;
  redisUrl: string;
  sessionSecret: string;
}>;

let cached: AppEnv | undefined;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`ENV_${name}_REQUIRED`);
  return value;
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "4000");
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("ENV_API_PORT_INVALID");
  }
  return parsed;
}

export function getEnv(): AppEnv {
  if (cached) return cached;

  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("ENV_NODE_ENV_INVALID");
  }

  const sessionSecret = required("SESSION_SECRET");
  if (nodeEnv === "production" && sessionSecret.length < 32) {
    throw new Error("ENV_SESSION_SECRET_TOO_SHORT");
  }

  cached = {
    nodeEnv: nodeEnv as AppEnv["nodeEnv"],
    apiPort: parsePort(process.env.API_PORT),
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    sessionSecret
  };

  return cached;
}

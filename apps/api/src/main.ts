import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";
import { getEnv } from "./infrastructure/config/env";
import { ApiExceptionFilter } from "./infrastructure/http/api-exception.filter";
import { traceMiddleware } from "./infrastructure/http/trace.middleware";
import { securityHeadersMiddleware } from "./infrastructure/http/security-headers.middleware";

async function bootstrap(): Promise<void> {
  const env = getEnv();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false
  });

  // Never trust arbitrary X-Forwarded-For: only explicit reverse proxies
  // (loopback by default) may supply the real client IP used by throttling.
  const proxies = (process.env.COREBIZ_TRUSTED_PROXIES || "loopback")
    .split(",").map((value) => value.trim()).filter(Boolean);
  app.getHttpAdapter().getInstance().set("trust proxy", proxies);

  app.use(json({ limit: "22mb" }));
  app.use(urlencoded({ extended: true, limit: "1mb" }));
  app.use(securityHeadersMiddleware);

  app.enableCors({
    origin: env.webOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Trace-Id"]
  });

  app.use(traceMiddleware);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();

  await app.listen(env.apiPort, "0.0.0.0");
}

void bootstrap();

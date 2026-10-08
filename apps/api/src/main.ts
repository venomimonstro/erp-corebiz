import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { getEnv } from "./infrastructure/config/env";
import { ApiExceptionFilter } from "./infrastructure/http/api-exception.filter";
import { traceMiddleware } from "./infrastructure/http/trace.middleware";

async function bootstrap(): Promise<void> {
  const env = getEnv();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  });

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

import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../../platform/authorization/authorization.module";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";

@Module({
  imports: [AuthorizationModule],
  controllers: [TasksController],
  providers: [TasksService]
})
export class TasksModule {}

import { Module } from "@nestjs/common";
import { DomainEventService } from "./domain-event.service";

@Module({
  providers: [DomainEventService],
  exports: [DomainEventService]
})
export class DomainEventModule {}

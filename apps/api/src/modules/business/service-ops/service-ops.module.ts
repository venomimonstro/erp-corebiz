import { Module } from "@nestjs/common";
import { DomainEventModule } from "../../platform/events/domain-event.module";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";
import { ResourcesController } from "./resources.controller";
import { ResourcesService } from "./resources.service";

@Module({
  imports: [DomainEventModule],
  controllers: [ResourcesController, BookingController],
  providers: [ResourcesService, BookingService],
  exports: [ResourcesService, BookingService]
})
export class ServiceOpsModule {}

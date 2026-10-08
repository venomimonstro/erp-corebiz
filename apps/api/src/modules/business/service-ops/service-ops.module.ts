import { Module } from "@nestjs/common";
import { DomainEventModule } from "../../platform/events/domain-event.module";
import { InventoryModule } from "../inventory/inventory.module";
import { GrowthModule } from "../growth/growth.module";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";
import { ResourcesController } from "./resources.controller";
import { ResourcesService } from "./resources.service";
import { ServiceWorkspaceController } from "./service-workspace.controller";
import { ServiceWorkspaceService } from "./service-workspace.service";

@Module({
  imports: [DomainEventModule, InventoryModule, GrowthModule],
  controllers: [
    ResourcesController,
    BookingController,
    ServiceWorkspaceController
  ],
  providers: [
    ResourcesService,
    BookingService,
    ServiceWorkspaceService
  ],
  exports: [
    ResourcesService,
    BookingService,
    ServiceWorkspaceService
  ]
})
export class ServiceOpsModule {}

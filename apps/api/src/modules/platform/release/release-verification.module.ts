import { Module } from "@nestjs/common";
import { ReleaseVerificationController } from "./release-verification.controller";
import { ReleaseVerificationService } from "./release-verification.service";

@Module({
  controllers: [ReleaseVerificationController],
  providers: [ReleaseVerificationService],
  exports: [ReleaseVerificationService]
})
export class ReleaseVerificationModule {}

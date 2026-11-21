import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@common';
import { HandoverService } from './handover.service';

/** Acknowledgement by email link for custodians without a user account (B3 §4.3). */
@ApiTags('handover')
@Controller('handover-ack')
export class HandoverAckController {
  constructor(private readonly service: HandoverService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  view(@Param('token') token: string) {
    return this.service.publicView(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  respond(
    @Param('token') token: string,
    @Body() body: { accept?: boolean; note?: string },
    @Ip() ip: string,
  ) {
    return this.service.publicRespond(
      token,
      body?.accept === true,
      body?.note,
      ip,
    );
  }
}

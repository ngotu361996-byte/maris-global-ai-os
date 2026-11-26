import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import {
  bootstrapRequestSchema,
  loginRequestSchema,
  totpVerifyRequestSchema,
  type BootstrapRequest,
  type LoginRequest,
  type MeResponse,
  type SessionResponse,
  type TotpVerifyRequest,
} from '@maris/contracts';
import type { Request } from 'express';
import { ZodPipe } from '../common/zod.pipe';
import { clientIp, CurrentUser, type AuthUser } from '../common/request-context';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('bootstrap')
  bootstrap(@Body(new ZodPipe(bootstrapRequestSchema)) body: BootstrapRequest, @Req() req: Request): Promise<SessionResponse> {
    return this.auth.bootstrap(body, client(req));
  }

  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginRequestSchema)) body: LoginRequest, @Req() req: Request): Promise<SessionResponse> {
    return this.auth.login(body, client(req));
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout(user.sessionId);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.auth.me(user.id);
  }

  @Post('mfa/totp/setup')
  @UseGuards(AuthGuard)
  setupTotp(@CurrentUser() user: AuthUser) {
    return this.auth.startTotpSetup(user);
  }

  @Post('mfa/totp/verify')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  verifyTotp(@CurrentUser() user: AuthUser, @Body(new ZodPipe(totpVerifyRequestSchema)) body: TotpVerifyRequest) {
    return this.auth.confirmTotp(user, body.code);
  }
}

function client(req: Request) {
  return { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

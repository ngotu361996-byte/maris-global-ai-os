import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
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
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import { ZodPipe } from '../common/zod.pipe';
import { clientIp, CurrentUser, type AuthUser } from '../common/request-context';
import { RateLimit } from '../ratelimit/rate-limit.guard';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { clearSessionCookie, setSessionCookie, wantsCookie } from './session-cookie';

const LOGIN_LIMIT = { name: 'login', limit: 20, windowSec: 900, by: 'ip+email' } as const;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('bootstrap')
  @RateLimit({ name: 'bootstrap', limit: 10, windowSec: 900, by: 'ip' })
  async bootstrap(
    @Body(new ZodPipe(bootstrapRequestSchema)) body: BootstrapRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Partial<SessionResponse>> {
    return this.respond(req, res, await this.auth.bootstrap(body, client(req)));
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit(LOGIN_LIMIT)
  async login(
    @Body(new ZodPipe(loginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Partial<SessionResponse>> {
    return this.respond(req, res, await this.auth.login(body, client(req)));
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(user.sessionId);
    clearSessionCookie(res, this.secureCookies);
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
  @RateLimit({ name: 'mfa-verify', limit: 10, windowSec: 900, by: 'ip' })
  verifyTotp(@CurrentUser() user: AuthUser, @Body(new ZodPipe(totpVerifyRequestSchema)) body: TotpVerifyRequest) {
    return this.auth.confirmTotp(user, body.code);
  }

  private get secureCookies(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  /** Browsers get an httpOnly cookie and no token in the body; API clients get the token. */
  private respond(req: Request, res: Response, session: SessionResponse): Partial<SessionResponse> {
    if (!wantsCookie(req)) return session;
    setSessionCookie(res, session.token, new Date(session.expiresAt), this.secureCookies);
    return { expiresAt: session.expiresAt };
  }
}

function client(req: Request) {
  return { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

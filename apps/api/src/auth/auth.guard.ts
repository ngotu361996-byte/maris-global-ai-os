import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { MarisRequest } from '../common/request-context';
import { AuthService } from './auth.service';

/** Resolves `Authorization: Bearer <token>` to a live session. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MarisRequest>();
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!match?.[1]) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Cần đăng nhập' });
    const user = await this.auth.resolveSession(match[1]);
    if (!user) throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập hết hạn' });
    req.user = user;
    return true;
  }
}

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { MarisRequest } from '../common/request-context';
import { AuthService } from './auth.service';
import { CSRF_HEADER, sessionTokenWithSource } from './session-cookie';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the session from `Authorization: Bearer <token>` or the httpOnly cookie.
 * Cookie-authenticated writes must carry the CSRF header.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MarisRequest>();
    const found = sessionTokenWithSource(req);
    if (!found) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Cần đăng nhập' });
    if (found.source === 'cookie' && !SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
      throw new ForbiddenException({ code: 'CSRF_HEADER_MISSING', message: 'Thiếu header chống CSRF' });
    }
    const user = await this.auth.resolveSession(found.token);
    if (!user) throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập hết hạn' });
    req.user = user;
    return true;
  }
}

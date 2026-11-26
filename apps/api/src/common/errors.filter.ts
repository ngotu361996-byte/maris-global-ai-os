import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@maris/contracts';

/** Every error leaves the API as { error: { code, message, details? } }. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const body: ApiError = {
        error: {
          code: typeof obj.code === 'string' ? obj.code : httpCode(status),
          message: typeof obj.message === 'string' ? obj.message : exception.message,
          ...(obj.details !== undefined ? { details: obj.details } : {}),
        },
      };
      res.status(status).json(body);
      return;
    }
    this.logger.error(exception);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống' } } satisfies ApiError);
  }
}

function httpCode(status: number): string {
  return (
    { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' }[status] ??
    'ERROR'
  );
}

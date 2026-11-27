import { BadRequestException, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { FileResponse } from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import type { Ctx } from './chat.service';
import { FilesService } from './files.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({ tenantId: tenant.id, userId: user.id, ip: clientIp(req) });

/**
 * File upload as the raw request body (Content-Type: application/octet-stream) with the name in
 * the X-File-Name header, URI-encoded. No multipart parser is needed and the size limit applies
 * while reading.
 */
@Controller('ai/files')
@UseGuards(AuthGuard, TenantGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @RequirePermission('ai.chat')
  async upload(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<FileResponse> {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
      throw new BadRequestException({ code: 'FILE_BAD_REQUEST', message: 'Gửi tệp với Content-Type application/octet-stream' });
    }
    let name: string;
    try {
      name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    } catch {
      throw new BadRequestException({ code: 'FILE_BAD_REQUEST', message: 'Tên tệp không hợp lệ' });
    }
    if (!name) throw new BadRequestException({ code: 'FILE_BAD_REQUEST', message: 'Thiếu tên tệp (X-File-Name)' });
    const data = await this.files.readBody(req);
    return this.files.upload(ctxOf(user, tenant, req), name, data);
  }

  @Get()
  @RequirePermission('ai.chat')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<FileResponse[]> {
    return this.files.list(ctxOf(user, tenant, req));
  }

  /** Always a download: never rendered as a page by the browser. */
  @Get(':id/content')
  @RequirePermission('ai.chat')
  async content(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { row, data } = await this.files.content(ctxOf(user, tenant, req), id);
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(data);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('ai.chat')
  remove(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request): Promise<void> {
    return this.files.remove(ctxOf(user, tenant, req), id);
  }
}

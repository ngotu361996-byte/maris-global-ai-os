import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  assetsQuery,
  createAssetSchema,
  createFolderSchema,
  createItemSchema,
  createVersionSchema,
  itemsQuery,
  publishSchema,
  renameFolderSchema,
  reviewSchema,
  updateAssetSchema,
  updateItemSchema,
  uploadAssetQuery,
  uploadVersionQuery,
  generateSchema,
  variantSchema,
  CONTENT_LIBRARIES,
  IMAGE_PRESETS,
  processImageSchema,
  processVideoSchema,
  voiceoverSchema,
  VIDEO_COVER,
  type ProcessVideo,
  type VoiceoverInput,
  type VoiceoverResponse,
  type MediaJobResponse,
  type MediaJobsResponse,
  type MediaOutputResponse,
  type ProcessImage,
  type Generate,
  type Variant,
  type AssetResponse,
  type CreateAsset,
  type CreateFolder,
  type CreateItem,
  type CreateVersion,
  type FolderResponse,
  type ItemDetailResponse,
  type ItemResponse,
  type Publish,
  type Review,
  type UpdateAsset,
  type UpdateItem,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  clientIp,
  CurrentTenant,
  CurrentUser,
  type AuthUser,
  type TenantContext,
} from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RateLimit } from '../ratelimit/rate-limit.guard';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { ContentAiService } from './content-ai.service';
import { ContentMediaService } from './content-media.service';
import { ContentService } from './content.service';
import { ContentVoiceService } from './content-voice.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

const libraryQuery = z.object({ library: z.enum(CONTENT_LIBRARIES) });
const inlineQuery = z.object({ inline: z.enum(['0', '1']).default('0') });

/** File uploads are the raw body (application/octet-stream) with the name in X-File-Name. */
function uploadName(req: Request): string {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream'))
    throw new BadRequestException({
      code: 'FILE_BAD_REQUEST',
      message: 'Gửi tệp với Content-Type application/octet-stream',
    });
  let name = '';
  try {
    name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
  } catch {
    /* handled below */
  }
  if (!name)
    throw new BadRequestException({
      code: 'FILE_BAD_REQUEST',
      message: 'Thiếu tên tệp (X-File-Name)',
    });
  return name;
}

/** Media is shown inline only when asked and safe; everything is sandboxed and never sniffed. */
function sendFile(
  res: Response,
  f: { stream: NodeJS.ReadableStream; size: number; name: string; mime: string; inlineOk: boolean },
  inline: boolean,
): void {
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  res.setHeader(
    'Content-Disposition',
    `${inline && f.inlineOk ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  );
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  f.stream.pipe(res);
}

@Controller('content')
@UseGuards(AuthGuard, TenantGuard)
export class ContentController {
  constructor(
    private readonly content: ContentService,
    private readonly ai: ContentAiService,
    private readonly media: ContentMediaService,
    private readonly voice: ContentVoiceService,
  ) {}

  // ---------------------------------------------------------------- folders

  @Get('folders')
  @RequirePermission('content.read')
  folders(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(libraryQuery)) q: z.infer<typeof libraryQuery>,
    @Req() req: Request,
  ): Promise<FolderResponse[]> {
    return this.content.listFolders(ctxOf(user, tenant, req), q.library);
  }

  @Post('folders')
  @RequirePermission('content.manage')
  createFolder(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createFolderSchema)) body: CreateFolder,
    @Req() req: Request,
  ): Promise<FolderResponse> {
    return this.content.createFolder(ctxOf(user, tenant, req), body);
  }

  @Patch('folders/:id')
  @HttpCode(204)
  @RequirePermission('content.manage')
  renameFolder(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(renameFolderSchema)) body: { name: string },
    @Req() req: Request,
  ): Promise<void> {
    return this.content.renameFolder(ctxOf(user, tenant, req), id, body.name);
  }

  @Delete('folders/:id')
  @HttpCode(204)
  @RequirePermission('content.manage')
  deleteFolder(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.content.deleteFolder(ctxOf(user, tenant, req), id);
  }

  // ---------------------------------------------------------------- source library (M09)

  @Get('assets')
  @RequirePermission('content.read')
  assets(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(assetsQuery)) q: z.infer<typeof assetsQuery>,
    @Req() req: Request,
  ): Promise<AssetResponse[]> {
    return this.content.listAssets(ctxOf(user, tenant, req), q);
  }

  @Post('assets')
  @RequirePermission('content.manage')
  createAsset(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createAssetSchema)) body: CreateAsset,
    @Req() req: Request,
  ): Promise<AssetResponse> {
    return this.content.createAsset(ctxOf(user, tenant, req), body);
  }

  @Post('assets/upload')
  @RequirePermission('content.manage')
  upload(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(uploadAssetQuery)) q: z.infer<typeof uploadAssetQuery>,
    @Req() req: Request,
  ): Promise<AssetResponse> {
    const name = uploadName(req);
    return this.content.uploadAsset(ctxOf(user, tenant, req), name, req, q);
  }

  @Get('assets/:id')
  @RequirePermission('content.read')
  asset(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AssetResponse> {
    return this.content.getAsset(ctxOf(user, tenant, req), id);
  }

  @Get('assets/:id/file')
  @RequirePermission('content.read')
  async assetFile(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(inlineQuery)) q: z.infer<typeof inlineQuery>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.content.assetFile(ctxOf(user, tenant, req), id), q.inline === '1');
  }

  @Patch('assets/:id')
  @RequirePermission('content.manage')
  updateAsset(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateAssetSchema)) body: UpdateAsset,
    @Req() req: Request,
  ): Promise<AssetResponse> {
    return this.content.updateAsset(ctxOf(user, tenant, req), id, body);
  }

  @Post('assets/:id/verify')
  @HttpCode(200)
  @RequirePermission('content.approve')
  verify(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AssetResponse> {
    return this.content.verifyAsset(ctxOf(user, tenant, req), id);
  }

  @Post('assets/:id/archive')
  @HttpCode(200)
  @RequirePermission('content.manage')
  archiveAsset(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AssetResponse> {
    return this.content.setArchived(ctxOf(user, tenant, req), id, true);
  }

  @Post('assets/:id/restore')
  @HttpCode(200)
  @RequirePermission('content.manage')
  restoreAsset(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AssetResponse> {
    return this.content.setArchived(ctxOf(user, tenant, req), id, false);
  }

  // ---------------------------------------------------------------- output library (M10)

  @Get('items')
  @RequirePermission('content.read')
  items(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(itemsQuery)) q: z.infer<typeof itemsQuery>,
    @Req() req: Request,
  ): Promise<ItemResponse[]> {
    return this.content.listItems(ctxOf(user, tenant, req), q);
  }

  @Post('items')
  @RequirePermission('content.manage')
  createItem(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createItemSchema)) body: CreateItem,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.createItem(ctxOf(user, tenant, req), body);
  }

  @Get('items/:id')
  @RequirePermission('content.read')
  item(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.getItem(ctxOf(user, tenant, req), id);
  }

  @Patch('items/:id')
  @RequirePermission('content.manage')
  updateItem(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateItemSchema)) body: UpdateItem,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.updateItem(ctxOf(user, tenant, req), id, body);
  }

  @Post('items/:id/versions')
  @RequirePermission('content.manage')
  version(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(createVersionSchema)) body: CreateVersion,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.createVersion(ctxOf(user, tenant, req), id, body);
  }

  @Post('items/:id/versions/upload')
  @RequirePermission('content.manage')
  uploadVersion(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(uploadVersionQuery)) q: z.infer<typeof uploadVersionQuery>,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    const name = uploadName(req);
    const ids = z.array(z.uuid()).max(50).safeParse(q.sourceAssetIds);
    if (!ids.success)
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'sourceAssetIds không hợp lệ',
      });
    return this.content.uploadVersion(ctxOf(user, tenant, req), id, name, req, {
      sourceAssetIds: ids.data,
      note: q.note,
    });
  }

  @Get('items/:id/versions/:version/file')
  @RequirePermission('content.read')
  async versionFile(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Query(new ZodPipe(inlineQuery)) q: z.infer<typeof inlineQuery>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(
      res,
      await this.content.versionFile(ctxOf(user, tenant, req), id, version),
      q.inline === '1',
    );
  }

  @Post('items/:id/submit')
  @HttpCode(200)
  @RequirePermission('content.manage')
  submit(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.submit(ctxOf(user, tenant, req), id);
  }

  @Post('items/:id/approve')
  @HttpCode(200)
  @RequirePermission('content.approve')
  approve(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(reviewSchema)) body: Review,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.approve(ctxOf(user, tenant, req), id, body);
  }

  @Post('items/:id/reject')
  @HttpCode(200)
  @RequirePermission('content.approve')
  reject(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(reviewSchema)) body: Review,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.reject(ctxOf(user, tenant, req), id, body);
  }

  @Post('items/:id/publish')
  @HttpCode(200)
  @RequirePermission('content.approve')
  publish(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(publishSchema)) body: Publish,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.publish(ctxOf(user, tenant, req), id, body);
  }

  @Post('items/:id/archive')
  @HttpCode(200)
  @RequirePermission('content.manage')
  archive(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.content.archive(ctxOf(user, tenant, req), id);
  }

  // ---------------------------------------------------------------- AI content writing

  @Post('items/:id/generate')
  @HttpCode(202)
  @RequirePermission('content.generate')
  generate(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(generateSchema)) body: Generate,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.ai.generate(ctxOf(user, tenant, req), id, body);
  }

  @Post('items/:id/variants')
  @HttpCode(202)
  @RequirePermission('content.generate')
  variant(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(variantSchema)) body: Variant,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.ai.variant(ctxOf(user, tenant, req), id, body);
  }

  @Post('generations/:id/cancel')
  @HttpCode(200)
  @RequirePermission('content.generate')
  cancelGeneration(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ItemDetailResponse> {
    return this.ai.cancel(ctxOf(user, tenant, req), id, tenant.permissions.has('ai.approve'));
  }

  // ---------------------------------------------------------------- AI voice-over

  @Post('items/:id/voiceover')
  @HttpCode(201)
  @RequirePermission('content.generate')
  @RateLimit({ name: 'content-voiceover', limit: 20, windowSec: 60, by: 'ip' })
  voiceover(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(voiceoverSchema)) body: VoiceoverInput,
    @Req() req: Request,
  ): Promise<VoiceoverResponse> {
    return this.voice.voiceover(ctxOf(user, tenant, req), id, body);
  }

  // ---------------------------------------------------------------- image and video processing

  @Post('assets/:id/process-image')
  @HttpCode(202)
  @RequirePermission('content.manage')
  processImage(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(processImageSchema)) body: ProcessImage,
    @Req() req: Request,
  ): Promise<MediaJobResponse> {
    return this.media.processImage(ctxOf(user, tenant, req), id, body);
  }

  @Post('assets/:id/process-video')
  @HttpCode(202)
  @RequirePermission('content.manage')
  processVideo(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(processVideoSchema)) body: ProcessVideo,
    @Req() req: Request,
  ): Promise<MediaJobResponse> {
    return this.media.processVideo(ctxOf(user, tenant, req), id, body);
  }

  @Get('assets/:id/media-jobs')
  @RequirePermission('content.read')
  mediaJobs(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<MediaJobsResponse> {
    return this.media.list(ctxOf(user, tenant, req), id);
  }

  @Post('media-jobs/:id/cancel')
  @HttpCode(200)
  @RequirePermission('content.manage')
  cancelMediaJob(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<MediaJobResponse> {
    return this.media.cancel(ctxOf(user, tenant, req), id);
  }
}

const outputQuery = z.object({ preset: z.enum([...IMAGE_PRESETS, VIDEO_COVER]) });

/**
 * Files of a media job, for the worker running it (device key in X-Maris-Device, no session).
 * The worker calls in; it can read only the image or video, logo and voice-over of a job it runs
 * now.
 */
@Controller('agent/jobs')
export class ContentAgentController {
  constructor(private readonly media: ContentMediaService) {}

  @Get(':id/files/:assetId')
  @RateLimit({ name: 'agent-file', limit: 120, windowSec: 60, by: 'ip' })
  async file(
    @Headers('x-maris-device') key: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.media.agentFile(key, id, assetId), false);
  }

  @Get(':id/items/:itemId')
  @RateLimit({ name: 'agent-file', limit: 120, windowSec: 60, by: 'ip' })
  async item(
    @Headers('x-maris-device') key: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendFile(res, await this.media.agentVoice(key, id, itemId), false);
  }

  @Post(':id/outputs')
  @RateLimit({ name: 'agent-output', limit: 120, windowSec: 60, by: 'ip' })
  output(
    @Headers('x-maris-device') key: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(outputQuery)) q: z.infer<typeof outputQuery>,
    @Req() req: Request,
  ): Promise<MediaOutputResponse> {
    return this.media.agentOutput(key, id, q.preset, uploadName(req), req);
  }
}

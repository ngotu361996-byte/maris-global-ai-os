import { BadRequestException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  createItemSchema,
  VOICE_DEFAULT_STYLE,
  VOICE_INFO,
  VOICE_ROTATION,
  VOICEOVER_LIMITS,
  voiceoverSchema,
  type Voice,
  type VoiceoverInput,
  type VoiceoverResponse,
} from '@maris/contracts';
import { baseUrlFor } from '../ai/adapters';
import type { ProviderRow } from '../ai/ai-router.service';
import { AiProvidersService } from '../ai/ai-providers.service';
import type { Ctx } from '../ai/chat.service';
import { ControlService } from '../ai/control.service';
import { CostGovernorService } from '../ai/cost-governor.service';
import { assertAllowedProviderUrl } from '../ai/url-guard';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { SecretVaultService } from '../secrets/secret-vault.service';
import { ContentService } from './content.service';

const { aiProviderCalls, contentItems, contentItemVersions } = schema;
const bad = (code: string, message: string) => new BadRequestException({ code, message });
/** Voice-overs are tagged so they can be found, and so auto can take the next voice in turn. */
const VOICE_TAG = 'ai-voice';
const TEXT_KINDS = new Set(['text', 'ad', 'other']);

/**
 * AI voice-over (spec Part 12: giọng đọc AI). A text item's current version is read aloud by an
 * OpenAI voice and saved as a new audio item in draft, linked to the text it reads and to that
 * text's sources, so a person approves it before a video uses it. The call goes through the
 * Emergency Stop and the Cost Governor and is recorded with the other AI calls. On auto, voices
 * take turns between female and male, so a channel does not sound the same in every video.
 */
@Injectable()
export class ContentVoiceService {
  private readonly logger = new Logger('ContentVoice');

  constructor(
    private readonly db: DbService,
    private readonly content: ContentService,
    private readonly providers: AiProvidersService,
    private readonly governor: CostGovernorService,
    private readonly control: ControlService,
    private readonly vault: SecretVaultService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async voiceover(ctx: Ctx, itemId: string, raw: VoiceoverInput): Promise<VoiceoverResponse> {
    const body = voiceoverSchema.parse(raw);
    const plan = await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const item = await this.content.itemIn(tx, ctx, itemId);
      if (!TEXT_KINDS.has(item.kind))
        throw bad('VOICE_NOT_TEXT', 'Chỉ đọc được mục văn bản (bài viết, quảng cáo, kịch bản)');
      const [version] =
        item.currentVersion > 0
          ? await tx
              .select()
              .from(contentItemVersions)
              .where(
                and(
                  eq(contentItemVersions.itemId, item.id),
                  eq(contentItemVersions.version, item.currentVersion),
                ),
              )
          : [];
      const text = version?.body?.trim() ?? '';
      if (!text) throw bad('VOICE_NO_TEXT', 'Mục này chưa có nội dung để đọc');
      if (text.length > VOICEOVER_LIMITS.maxChars)
        throw bad(
          'VOICE_TEXT_TOO_LONG',
          `Nội dung dài ${text.length} ký tự, giọng đọc nhận tối đa ${VOICEOVER_LIMITS.maxChars}. Tách thành nhiều đoạn.`,
        );
      const enabled = (await this.providers.rows(tx, ctx.tenantId)).filter(
        (p) => p.enabled && p.kind === 'openai',
      );
      if (!enabled.length)
        throw bad(
          'VOICE_NO_PROVIDER',
          'Cần một AI Provider loại OpenAI đang bật (giọng đọc dùng OpenAI). Thêm ở trang AI Provider.',
        );
      const kept = await this.governor.filter(
        tx,
        ctx.tenantId,
        enabled.map((provider) => ({ provider, model: VOICEOVER_LIMITS.model })),
      );
      const provider = kept[0]!.provider;
      const apiKey = provider.secretRef
        ? await this.vault.resolve(tx, ctx.tenantId, provider.secretRef)
        : null;
      let voice: Voice;
      if (body.voice === 'auto') {
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(contentItems)
          .where(
            and(
              eq(contentItems.tenantId, ctx.tenantId),
              sql`${VOICE_TAG} = ANY(${contentItems.tags})`,
            ),
          )) as [{ n: number }];
        voice = VOICE_ROTATION[n % VOICE_ROTATION.length]!;
      } else voice = body.voice;
      return { item, version: version!, text, provider, apiKey, voice };
    });

    const language = plan.item.language === 'en' ? 'en' : 'vi';
    const style = body.style || VOICE_DEFAULT_STYLE[language];
    const started = Date.now();
    let audio: Buffer;
    try {
      audio = await this.speak(plan.provider, plan.apiKey, {
        model: VOICEOVER_LIMITS.model,
        voice: plan.voice,
        input: plan.text,
        speed: body.speed,
        instructions: speedHint(style, body.speed, language),
        response_format: 'mp3',
      });
    } catch (e) {
      const err = e instanceof VoiceError ? e : new VoiceError('UPSTREAM', String(e));
      await this.db.withContext(ctx, async (tx) => {
        await tx.insert(aiProviderCalls).values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          contentItemId: plan.item.id,
          providerId: plan.provider.id,
          model: VOICEOVER_LIMITS.model,
          outcome: err.code === 'TIMEOUT' ? 'timeout' : 'error',
          errorCode: err.code,
          latencyMs: Date.now() - started,
        });
      });
      this.logger.warn(`voice-over on provider ${plan.provider.id} failed: ${err.code}`);
      throw new HttpException(
        { code: 'VOICE_PROVIDER_ERROR', message: `Không tạo được giọng đọc: ${err.message}` },
        502,
      );
    }
    const latencyMs = Date.now() - started;
    const costUsd = Math.round(plan.text.length * VOICEOVER_LIMITS.usdPerMillionChars) / 1_000_000;

    const name = `giong-doc-${plan.voice}.mp3`;
    const file = await this.content.receiveFile(ctx, name, Readable.from([audio]));
    try {
      if (file.type.kind !== 'audio')
        throw new HttpException(
          { code: 'VOICE_PROVIDER_ERROR', message: 'Dịch vụ giọng đọc không trả về âm thanh' },
          502,
        );
      const saved = await this.db.withContext(ctx, async (tx) => {
        await tx.insert(aiProviderCalls).values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          contentItemId: plan.item.id,
          providerId: plan.provider.id,
          model: VOICEOVER_LIMITS.model,
          outcome: 'ok',
          costUsd: String(costUsd),
          latencyMs,
        });
        await this.governor.afterSpend(tx, ctx.tenantId);
        const title = (
          body.title ??
          `${plan.item.title} · Giọng đọc ${VOICE_INFO[plan.voice].label.split(' ')[0]}`
        ).slice(0, 200);
        let item = await this.content.createItemIn(
          tx,
          ctx,
          createItemSchema.parse({
            title,
            kind: 'audio',
            language: plan.item.language,
            market: plan.item.market,
            platform: plan.item.platform,
            folderId: plan.item.folderId,
            tags: [VOICE_TAG, plan.voice],
          }),
          plan.item.id,
        );
        item = await this.content.addFileVersionIn(tx, ctx, item, file, {
          sourceAssetIds: plan.version.sourceAssetIds,
          workerJobId: null,
          note: `Giọng đọc AI ${VOICE_INFO[plan.voice].label}, tốc độ ${body.speed}×, đọc phiên bản ${plan.version.version} của “${plan.item.title}” (${VOICEOVER_LIMITS.model})`,
        });
        await this.audit.append(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'content.voiceover.created',
          targetType: 'content_item',
          targetId: item.id,
          metadata: {
            fromItemId: plan.item.id,
            fromVersion: plan.version.version,
            providerId: plan.provider.id,
            model: VOICEOVER_LIMITS.model,
            voice: plan.voice,
            speed: body.speed,
            chars: plan.text.length,
            costUsd,
            sha256: file.sha256,
          },
          ip: ctx.ip,
        });
        await file.staged.commit();
        return item;
      });
      return {
        itemId: saved.id,
        title: saved.title,
        voice: plan.voice,
        speed: body.speed,
        chars: plan.text.length,
        costUsd,
      };
    } catch (e) {
      await file.staged.discard();
      throw e;
    }
  }

  /** One call to the provider's speech endpoint; the key is sent only to that provider. */
  private async speak(
    provider: ProviderRow,
    apiKey: string | null,
    payload: Record<string, unknown>,
  ): Promise<Buffer> {
    const baseUrl = baseUrlFor(provider.kind, provider.baseUrl);
    await assertAllowedProviderUrl(baseUrl, {
      kind: provider.kind,
      allowPrivate: this.config.AI_ALLOW_PRIVATE_URLS,
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VOICEOVER_LIMITS.timeoutSec * 1000);
    try {
      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j.error?.message) message = `${message}: ${j.error.message.slice(0, 200)}`;
        } catch {
          /* not JSON */
        }
        throw new VoiceError(
          res.status === 401 || res.status === 403 ? 'AUTH' : 'UPSTREAM',
          message,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new VoiceError('UPSTREAM', 'Không nhận được âm thanh');
      return buf;
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      if (ctrl.signal.aborted)
        throw new VoiceError(
          'TIMEOUT',
          `Quá ${VOICEOVER_LIMITS.timeoutSec} giây không có phản hồi`,
        );
      throw new VoiceError('UPSTREAM', 'Không kết nối được dịch vụ giọng đọc');
    } finally {
      clearTimeout(timer);
    }
  }
}

class VoiceError extends Error {
  constructor(
    readonly code: 'AUTH' | 'UPSTREAM' | 'TIMEOUT',
    message: string,
  ) {
    super(message);
  }
}

/** The reading style, plus the pace in words, for voices that follow instructions over speed. */
export function speedHint(style: string, speed: number, language: 'vi' | 'en'): string {
  if (speed >= 0.95 && speed <= 1.05) return style;
  const faster = speed > 1;
  const hint =
    language === 'vi'
      ? faster
        ? 'Nhịp đọc nhanh hơn bình thường.'
        : 'Nhịp đọc chậm rãi hơn bình thường.'
      : faster
        ? 'Speak at a faster pace than usual.'
        : 'Speak at a slower, relaxed pace.';
  return `${style} ${hint}`;
}

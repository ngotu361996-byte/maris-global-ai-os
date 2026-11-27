import { z } from 'zod';

/**
 * Content libraries (spec Part 11): the source library (M09) keeps original files, product facts and
 * references with where they came from and the right to use them; the output library (M10) keeps
 * finished content as numbered versions that are never overwritten, each traceable to its sources,
 * the Skill or Workflow that made it and its approval.
 */

export const ASSET_KINDS = [
  'video',
  'image',
  'audio',
  'document',
  'text',
  'product',
  'reference',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  video: 'Video gốc',
  image: 'Hình ảnh gốc',
  audio: 'Âm thanh gốc',
  document: 'Tài liệu',
  text: 'Văn bản',
  product: 'Thông tin sản phẩm',
  reference: 'Nội dung tham khảo',
};
/** Kinds that hold a file; the others hold text or product facts. */
export const FILE_ASSET_KINDS = ['video', 'image', 'audio', 'document'] as const;

export const ASSET_SOURCES = ['upload', 'manual', 'connector', 'url'] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];
export const ASSET_SOURCE_LABEL: Record<AssetSource, string> = {
  upload: 'Tải lên thủ công',
  manual: 'Nhập tay',
  connector: 'Từ Connector',
  url: 'Từ đường dẫn',
};

export const RIGHTS_STATUSES = [
  'owned',
  'licensed',
  'permission',
  'unknown',
  'restricted',
] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];
export const RIGHTS_LABEL: Record<RightsStatus, string> = {
  owned: 'Của doanh nghiệp',
  licensed: 'Có giấy phép',
  permission: 'Được chủ sở hữu cho phép',
  unknown: 'Chưa rõ quyền',
  restricted: 'Không được dùng',
};
/** Rights that allow a finished item made from the asset to be approved. */
export const USABLE_RIGHTS: readonly RightsStatus[] = ['owned', 'licensed', 'permission'];

export const CONTENT_LIBRARIES = ['source', 'output'] as const;
export type ContentLibrary = (typeof CONTENT_LIBRARIES)[number];

export const ITEM_KINDS = ['video', 'image', 'text', 'ad', 'audio', 'other'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  video: 'Video',
  image: 'Hình ảnh',
  text: 'Bài viết',
  ad: 'Nội dung quảng cáo',
  audio: 'Âm thanh',
  other: 'Khác',
};

export const PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'google',
  'website',
  'shopify',
  'email',
  'other',
] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABEL: Record<Platform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  google: 'Google',
  website: 'Website',
  shopify: 'Shopify',
  email: 'Email',
  other: 'Khác',
};

export const ITEM_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'rejected',
  'published',
  'archived',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  draft: 'Bản nháp',
  in_review: 'Chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Bị từ chối',
  published: 'Đã xuất bản',
  archived: 'Lưu trữ',
};

export const LANGUAGES: Record<string, string> = { vi: 'Tiếng Việt', en: 'Tiếng Anh' };

export const CONTENT_LIMITS = {
  bodyMaxChars: 200_000,
  tagsMax: 30,
  sourcesMax: 50,
} as const;

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(50)
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'Tag chỉ gồm chữ, số, khoảng trắng và _ . -');
const tags = z
  .array(tag)
  .max(CONTENT_LIMITS.tagsMax)
  .transform((t) => [...new Set(t)]);
const isoDate = z.iso.datetime({ offset: true });

export const productFactsSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    sku: z.string().trim().max(100).optional(),
    price: z.number().min(0).max(1e12).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    url: z.url().max(1000).optional(),
    /** Facts the AI may use, e.g. Chất liệu: cotton 100%. */
    specs: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(100),
          value: z.string().trim().min(1).max(1000),
        }),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type ProductFacts = z.infer<typeof productFactsSchema>;

const rightsFields = {
  rightsStatus: z.enum(RIGHTS_STATUSES).default('unknown'),
  rightsHolder: z.string().trim().max(200).nullable().default(null),
  rightsNote: z.string().trim().max(2000).nullable().default(null),
  rightsExpiresAt: isoDate.nullable().default(null),
};

/** A source asset without a file: text, product facts or a reference. */
export const createAssetSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['text', 'product', 'reference']),
    description: z.string().trim().max(5000).nullable().default(null),
    body: z.string().max(CONTENT_LIMITS.bodyMaxChars).nullable().default(null),
    product: productFactsSchema.nullable().default(null),
    folderId: z.uuid().nullable().default(null),
    source: z.enum(['manual', 'connector', 'url']).default('manual'),
    sourceRef: z.string().trim().max(1000).nullable().default(null),
    tags: tags.default([]),
    ...rightsFields,
  })
  .refine((a) => (a.kind === 'product' ? !!a.product : !!a.body?.trim()), {
    message: 'Sản phẩm cần thông tin sản phẩm; văn bản và tham khảo cần nội dung',
    path: ['body'],
  });
export type CreateAsset = z.input<typeof createAssetSchema>;

/** Metadata of an uploaded file, sent as query parameters with the upload. */
export const uploadAssetQuery = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  folderId: z.uuid().optional(),
  rightsStatus: z.enum(RIGHTS_STATUSES).default('unknown'),
  rightsHolder: z.string().trim().max(200).optional(),
  tags: z
    .string()
    .max(2000)
    .optional()
    .transform((s) =>
      s
        ? s
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(tags),
  sourceRef: z.string().trim().max(1000).optional(),
});

/** Editing an asset changes its description, never its file or (once used) its facts. */
export const updateAssetSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    folderId: z.uuid().nullable(),
    tags,
    sourceRef: z.string().trim().max(1000).nullable(),
    rightsStatus: z.enum(RIGHTS_STATUSES),
    rightsHolder: z.string().trim().max(200).nullable(),
    rightsNote: z.string().trim().max(2000).nullable(),
    rightsExpiresAt: isoDate.nullable(),
  })
  .partial();
export type UpdateAsset = z.input<typeof updateAssetSchema>;

export const assetsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  folderId: z.uuid().optional(),
  tag: z.string().trim().toLowerCase().max(50).optional(),
  rights: z.enum(RIGHTS_STATUSES).optional(),
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createFolderSchema = z.object({
  library: z.enum(CONTENT_LIBRARIES),
  name: z.string().trim().min(1).max(100),
  parentId: z.uuid().nullable().default(null),
});
export type CreateFolder = z.input<typeof createFolderSchema>;
export const renameFolderSchema = z.object({ name: z.string().trim().min(1).max(100) });

/** Where a version came from. */
const lineage = {
  sourceAssetIds: z
    .array(z.uuid())
    .max(CONTENT_LIMITS.sourcesMax)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  skillId: z.uuid().nullable().default(null),
  workflowRunId: z.uuid().nullable().default(null),
  aiTaskId: z.uuid().nullable().default(null),
  note: z.string().trim().max(1000).nullable().default(null),
};

export const createItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(ITEM_KINDS),
  language: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Mã ngôn ngữ dạng vi, en hoặc en-US')
    .default('vi'),
  market: z.string().trim().max(50).nullable().default(null),
  platform: z.enum(PLATFORMS).nullable().default(null),
  folderId: z.uuid().nullable().default(null),
  tags: tags.default([]),
  /** The first version's text; a file version can be added after. */
  body: z.string().max(CONTENT_LIMITS.bodyMaxChars).nullable().default(null),
  ...lineage,
});
export type CreateItem = z.input<typeof createItemSchema>;

export const updateItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    market: z.string().trim().max(50).nullable(),
    platform: z.enum(PLATFORMS).nullable(),
    folderId: z.uuid().nullable(),
    tags,
  })
  .partial();
export type UpdateItem = z.input<typeof updateItemSchema>;

/** A new text version. File versions are uploaded with the same lineage fields as query parameters. */
export const createVersionSchema = z.object({
  body: z.string().min(1).max(CONTENT_LIMITS.bodyMaxChars),
  ...lineage,
});
export type CreateVersion = z.input<typeof createVersionSchema>;

export const uploadVersionQuery = z.object({
  sourceAssetIds: z
    .string()
    .max(2000)
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : [])),
  note: z.string().trim().max(1000).optional(),
});

export const reviewSchema = z.object({
  note: z.string().trim().max(1000).nullable().default(null),
});
export type Review = z.input<typeof reviewSchema>;
export const publishSchema = z.object({
  url: z.url().max(1000).nullable().default(null),
});
export type Publish = z.input<typeof publishSchema>;

export const itemsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  platform: z.enum(PLATFORMS).optional(),
  language: z.string().max(10).optional(),
  folderId: z.uuid().optional(),
  tag: z.string().trim().toLowerCase().max(50).optional(),
  sourceAssetId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export interface FolderResponse {
  id: string;
  library: ContentLibrary;
  name: string;
  parentId: string | null;
  count: number;
}

export interface FileInfo {
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

export interface AssetResponse {
  id: string;
  title: string;
  kind: AssetKind;
  description: string | null;
  body: string | null;
  product: ProductFacts | null;
  file: FileInfo | null;
  folderId: string | null;
  source: AssetSource;
  sourceRef: string | null;
  rightsStatus: RightsStatus;
  rightsHolder: string | null;
  rightsNote: string | null;
  rightsExpiresAt: string | null;
  /** Rights allow use now (a usable status that has not expired). */
  usable: boolean;
  verifiedAt: string | null;
  verifiedByName: string | null;
  tags: string[];
  /** Finished items whose versions use this asset. */
  usedBy: number;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface VersionResponse {
  id: string;
  version: number;
  body: string | null;
  file: FileInfo | null;
  sources: {
    id: string;
    title: string;
    kind: AssetKind;
    rightsStatus: RightsStatus;
    usable: boolean;
  }[];
  skillId: string | null;
  skillName: string | null;
  workflowRunId: string | null;
  aiTaskId: string | null;
  /** Numbers or claims in an AI-written version that its facts do not support. */
  aiWarnings: string[];
  note: string | null;
  createdByName: string;
  createdAt: string;
}

export interface ItemResponse {
  id: string;
  title: string;
  kind: ItemKind;
  language: string;
  market: string | null;
  platform: Platform | null;
  status: ItemStatus;
  folderId: string | null;
  tags: string[];
  currentVersion: number;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  /** The item this one was made from in another language, market or platform. */
  variantOf: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ItemDetailResponse extends ItemResponse {
  versions: VersionResponse[];
  /** Why the item cannot be approved now, e.g. a source without usable rights. */
  approvalBlockers: string[];
  /** AI writing runs for this item, newest first. */
  generations: GenerationResponse[];
  /** Items made from this one in other languages, markets or platforms. */
  variants: {
    id: string;
    title: string;
    language: string;
    platform: Platform | null;
    status: ItemStatus;
  }[];
}

// ------------------------------------------------------------------------- AI content writing

/**
 * AI content writing (spec Part 13, M13). The AI writes the next version of an item from verified
 * product facts and reference sources, as an AI task already approved by the person who asked.
 * Product facts must be verified first. The result is checked: numbers and advertising claims the
 * facts do not support become warnings, and an AI version with warnings cannot be approved until a
 * person edits it into a new version.
 */
export const CONTENT_AI_LIMITS = {
  briefMaxChars: 4000,
  productsMax: 10,
  referencesMax: 20,
  /** Reference text sent to the AI, in total. */
  referenceChars: 20_000,
  budgetDefaultUsd: 0.2,
  budgetMaxUsd: 2,
  timeoutSec: 300,
} as const;

/** Suggested tones; any short text is accepted. */
export const CONTENT_TONES = [
  'Thân thiện, gần gũi',
  'Chuyên nghiệp, đáng tin',
  'Hào hứng, năng động',
  'Sang trọng, tinh tế',
  'Ngắn gọn, đi thẳng vào ý',
] as const;

const language = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Mã ngôn ngữ dạng vi, en hoặc en-US');
const aiRun = {
  brief: z.string().trim().max(CONTENT_AI_LIMITS.briefMaxChars).nullable().default(null),
  tone: z.string().trim().max(100).nullable().default(null),
  budgetUsd: z
    .number()
    .positive()
    .max(CONTENT_AI_LIMITS.budgetMaxUsd)
    .default(CONTENT_AI_LIMITS.budgetDefaultUsd),
  agentId: z.uuid().nullable().default(null),
};

/** Ask the AI to write the next version of an item. */
export const generateSchema = z.object({
  /** Verified product facts the text may use. */
  productAssetIds: z
    .array(z.uuid())
    .max(CONTENT_AI_LIMITS.productsMax)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  /** Text and reference sources to draw on. */
  sourceAssetIds: z
    .array(z.uuid())
    .max(CONTENT_AI_LIMITS.referencesMax)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  ...aiRun,
});
export type Generate = z.input<typeof generateSchema>;

/** Make a new item from this one's current text, in another language, market or platform. */
export const variantSchema = z.object({
  language,
  market: z.string().trim().max(50).nullable().default(null),
  platform: z.enum(PLATFORMS).nullable().default(null),
  title: z.string().trim().min(1).max(200).nullable().default(null),
  ...aiRun,
});
export type Variant = z.input<typeof variantSchema>;

export const GENERATION_STATUSES = ['running', 'done', 'failed', 'cancelled'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];
export const GENERATION_STATUS_LABEL: Record<GenerationStatus, string> = {
  running: 'AI đang viết',
  done: 'Đã viết xong',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

export interface GenerationResponse {
  id: string;
  mode: 'write' | 'variant';
  status: GenerationStatus;
  /** What the AI task is doing now, e.g. which AI is writing. */
  progress: string | null;
  taskId: string;
  fromItemId: string | null;
  fromVersion: number | null;
  productAssetIds: string[];
  sourceAssetIds: string[];
  brief: string | null;
  tone: string | null;
  /** The version the result was saved as. */
  version: number | null;
  warnings: string[];
  costUsd: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdByName: string;
  createdAt: string;
  finishedAt: string | null;
}

import { z } from 'zod';
import { taskLevelSchema, type TaskLevel } from './access-levels';
import { TASK_PERMISSIONS } from './tasks';

/** Format tag of an exported skill file. */
export const SKILL_FORMAT = 'maris.skill/v1';
export const SKILL_FIELD_TYPES = ['text', 'long_text', 'number', 'choice'] as const;
export type SkillFieldType = (typeof SKILL_FIELD_TYPES)[number];
export const SKILL_FIELD_TYPE_LABEL: Record<SkillFieldType, string> = {
  text: 'Một dòng',
  long_text: 'Nhiều dòng',
  number: 'Số',
  choice: 'Chọn một',
};
export const SKILL_MAX_INPUTS = 12;
/** Default and maximum length of one text input. */
export const SKILL_INPUT_MAX_CHARS = 8000;

const skillKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'mã Skill chỉ gồm chữ thường không dấu, số, - và _');
const semver = z
  .string()
  .trim()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'phiên bản dạng 1.0.0');

export const skillFieldSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/, 'tên ô nhập chỉ gồm chữ thường không dấu, số và _'),
    label: z.string().trim().min(1).max(80),
    type: z.enum(SKILL_FIELD_TYPES),
    required: z.boolean().default(true),
    options: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
    maxLength: z.number().int().min(1).max(SKILL_INPUT_MAX_CHARS).optional(),
  })
  .refine(
    (f) => f.type !== 'choice' || (f.options?.length ?? 0) > 0,
    'ô "Chọn một" cần danh sách lựa chọn',
  );
export type SkillField = z.output<typeof skillFieldSchema>;

/** Placeholders like {{product}} in the instructions. */
export function skillPlaceholders(instructions: string): string[] {
  return [
    ...new Set([...instructions.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!)),
  ];
}

const skillBody = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  inputs: z.array(skillFieldSchema).max(SKILL_MAX_INPUTS),
  instructions: z.string().trim().min(1).max(8000),
  successCriteria: z.string().trim().min(1).max(2000),
  requiredLevel: taskLevelSchema,
  budgetUsd: z.number().positive().max(50),
  timeoutSec: z.number().int().min(10).max(600),
};

/** Instructions may only use declared inputs, and input names must be unique. */
function checkFields(v: { inputs?: SkillField[]; instructions?: string }, ctx: z.RefinementCtx) {
  if (!v.inputs) return;
  const names = v.inputs.map((f) => f.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup)
    ctx.addIssue({ code: 'custom', path: ['inputs'], message: `ô nhập "${dup}" bị trùng tên` });
  if (v.instructions) {
    const unknown = skillPlaceholders(v.instructions).filter((p) => !names.includes(p));
    if (unknown.length)
      ctx.addIssue({
        code: 'custom',
        path: ['instructions'],
        message: `hướng dẫn dùng ô chưa khai báo: ${unknown.join(', ')}`,
      });
  }
}

export const createSkillSchema = z
  .object({ key: skillKey, ...skillBody, author: z.string().trim().min(1).max(120).optional() })
  .superRefine(checkFields);
export type CreateSkill = z.input<typeof createSkillSchema>;

export const updateSkillSchema = z
  .object({ ...skillBody, status: z.enum(['active', 'paused']) })
  .partial()
  .superRefine((v, ctx) => {
    if (!Object.keys(v).length)
      ctx.addIssue({ code: 'custom', message: 'không có gì để cập nhật' });
    // Instructions and inputs are checked together when either changes; the service merges with the stored skill.
    checkFields(v, ctx);
  });
export type UpdateSkill = z.input<typeof updateSkillSchema>;

/** The exported file. Every field the spec asks of an extension (Part 23) is here. */
export const skillManifestSchema = z
  .object({
    format: z.literal(SKILL_FORMAT),
    key: skillKey,
    version: semver,
    author: z.string().trim().min(1).max(120),
    ...skillBody,
    output: z.object({ format: z.literal('markdown') }).default({ format: 'markdown' }),
    permissions: z
      .array(z.string())
      .min(1)
      .refine(
        (p) => p.every((x) => (TASK_PERMISSIONS as readonly string[]).includes(x)),
        'Skill chỉ được xin quyền ai.generate_text ở giai đoạn này',
      ),
    dependencies: z.array(z.string().max(200)).max(20).default([]),
    compatibility: z.object({ maris: z.string().max(40) }).default({ maris: '>=0.1.0' }),
    examples: z
      .array(
        z.object({
          inputs: z.record(
            z.string(),
            z.union([z.string().max(SKILL_INPUT_MAX_CHARS), z.number()]),
          ),
        }),
      )
      .max(5)
      .default([]),
    checksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine(checkFields);
export type SkillManifest = z.output<typeof skillManifestSchema>;

export const importSkillSchema = z.object({
  manifest: z.unknown(),
  /** Replace an installed skill with the same key. */
  replace: z.boolean().default(false),
});
export type ImportSkill = z.input<typeof importSkillSchema>;

export const runSkillSchema = z.object({
  inputs: z.record(z.string(), z.union([z.string().max(SKILL_INPUT_MAX_CHARS), z.number()])),
  agentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
});
export type RunSkill = z.infer<typeof runSkillSchema>;

/**
 * JSON with object keys sorted, so the same manifest always gives the same checksum. The
 * checksum is SHA-256 of this text for the manifest without its `checksum` field.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface SkillResponse {
  id: string;
  key: string;
  name: string;
  version: string;
  description: string;
  author: string;
  source: 'template' | 'created' | 'imported';
  inputs: SkillField[];
  output: { format: 'markdown' };
  permissions: string[];
  dependencies: string[];
  compatibility: { maris: string };
  examples: { inputs: Record<string, string | number> }[];
  instructions: string;
  successCriteria: string;
  requiredLevel: TaskLevel;
  budgetUsd: number;
  timeoutSec: number;
  checksum: string;
  status: 'active' | 'paused';
  updatedAt: string;
}

export interface SkillTemplate {
  key: string;
  name: string;
  description: string;
  inputs: SkillField[];
  instructions: string;
  successCriteria: string;
  requiredLevel: TaskLevel;
}

const f = (
  name: string,
  label: string,
  type: SkillFieldType = 'text',
  extra: Partial<SkillField> = {},
): SkillField => ({ name, label, type, required: true, ...extra });

/** Starter skills for a sales business. Installed per tenant from the Skill page. */
export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  {
    key: 'mo-ta-san-pham',
    name: 'Viết mô tả sản phẩm',
    description: 'Tiêu đề và mô tả sản phẩm chuẩn SEO cho sàn thương mại điện tử.',
    inputs: [
      f('san_pham', 'Tên sản phẩm'),
      f('dac_diem', 'Đặc điểm nổi bật', 'long_text'),
      f('san', 'Sàn bán', 'choice', { options: ['Shopee', 'TikTok Shop', 'Lazada', 'Website'] }),
    ],
    instructions:
      'Viết cho sản phẩm {{san_pham}} bán trên {{san}}: 3 phương án tiêu đề (dưới 120 ký tự, có từ khóa tìm kiếm) và một mô tả sản phẩm có gạch đầu dòng lợi ích, thông số và lời kêu gọi mua. Đặc điểm: {{dac_diem}}',
    successCriteria:
      'Có 3 tiêu đề dưới 120 ký tự và một mô tả đủ lợi ích, thông số, lời kêu gọi mua; không bịa thông số không có trong đặc điểm.',
    requiredLevel: 'prepare',
  },
  {
    key: 'bai-quang-cao-facebook',
    name: 'Viết bài quảng cáo Facebook',
    description: 'Ba phương án bài quảng cáo Facebook cho một sản phẩm và nhóm khách.',
    inputs: [
      f('san_pham', 'Sản phẩm'),
      f('khach_hang', 'Khách hàng mục tiêu'),
      f('uu_dai', 'Ưu đãi', 'text', { required: false }),
    ],
    instructions:
      'Viết 3 phương án bài quảng cáo Facebook cho {{san_pham}}, nhắm tới {{khach_hang}}. Ưu đãi (nếu có): {{uu_dai}}. Mỗi phương án gồm câu mở đầu thu hút, nội dung chính ngắn, lời kêu gọi hành động và gợi ý hình ảnh.',
    successCriteria:
      'Ba phương án khác nhau về góc tiếp cận, mỗi phương án dưới 150 chữ, có lời kêu gọi hành động.',
    requiredLevel: 'prepare',
  },
  {
    key: 'tra-loi-khach-hang',
    name: 'Soạn câu trả lời khách hàng',
    description: 'Câu trả lời lịch sự, đúng chính sách cho tin nhắn hoặc đánh giá của khách.',
    inputs: [
      f('tin_nhan', 'Tin nhắn hoặc đánh giá của khách', 'long_text'),
      f('chinh_sach', 'Chính sách liên quan', 'long_text', { required: false }),
    ],
    instructions:
      'Soạn 2 phương án trả lời cho khách. Tin nhắn của khách: {{tin_nhan}}. Chính sách cửa hàng: {{chinh_sach}}. Lịch sự, ngắn gọn, không hứa điều ngoài chính sách, xin lỗi khi cửa hàng có lỗi.',
    successCriteria:
      'Hai phương án lịch sự, đúng chính sách đã cho, không hứa điều ngoài chính sách.',
    requiredLevel: 'prepare',
  },
  {
    key: 'phan-tich-danh-gia',
    name: 'Phân tích đánh giá khách hàng',
    description: 'Tìm điểm khen, điểm chê và việc cần cải thiện từ các đánh giá.',
    inputs: [f('danh_gia', 'Các đánh giá (mỗi dòng một đánh giá)', 'long_text')],
    instructions:
      'Phân tích các đánh giá sau: {{danh_gia}}. Trả về: điểm được khen nhiều nhất, điểm bị chê nhiều nhất (kèm số lần), cảm xúc chung, và 3 việc nên cải thiện theo thứ tự ưu tiên.',
    successCriteria:
      'Có số lần cho mỗi điểm khen và chê, có 3 việc cải thiện xếp theo ưu tiên, không bịa đánh giá.',
    requiredLevel: 'analyze',
  },
  {
    key: 'kich-ban-video-ngan',
    name: 'Kịch bản video ngắn',
    description: 'Kịch bản video 30–60 giây cho TikTok, Reels hoặc Shorts.',
    inputs: [
      f('san_pham', 'Sản phẩm'),
      f('thong_diep', 'Thông điệp chính'),
      f('do_dai', 'Độ dài (giây)', 'choice', { options: ['30', '45', '60'] }),
    ],
    instructions:
      'Viết kịch bản video {{do_dai}} giây cho {{san_pham}} với thông điệp: {{thong_diep}}. Chia theo cảnh: thời gian, hình ảnh, lời thoại hoặc chữ trên màn hình. 3 giây đầu phải giữ chân người xem.',
    successCriteria:
      'Kịch bản chia cảnh có thời gian cộng lại đúng độ dài, có câu mở đầu giữ chân người xem và lời kêu gọi cuối.',
    requiredLevel: 'prepare',
  },
  {
    key: 'tom-tat-tai-lieu',
    name: 'Tóm tắt tài liệu',
    description: 'Tóm tắt một văn bản dài thành các ý chính và việc cần làm.',
    inputs: [
      f('noi_dung', 'Nội dung cần tóm tắt', 'long_text'),
      f('muc_dich', 'Bạn cần tóm tắt để làm gì', 'text', { required: false }),
    ],
    instructions:
      'Tóm tắt nội dung sau thành tối đa 7 ý chính và danh sách việc cần làm (nếu có). Mục đích của người đọc: {{muc_dich}}. Nội dung: {{noi_dung}}',
    successCriteria:
      'Tối đa 7 ý chính, đúng với nội dung gốc, có danh sách việc cần làm nếu nội dung có.',
    requiredLevel: 'read',
  },
];

import { z } from 'zod';
import { modelName } from './ai';
import { accessLevelSchema, type AccessLevel } from './access-levels';

const agentKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'mã Agent chỉ gồm chữ thường không dấu, số, - và _');

const agentFields = {
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(300),
  systemPrompt: z.string().trim().min(1).max(8000),
  evalCriteria: z.string().trim().max(2000).nullable(),
  providerId: z.string().uuid().nullable(),
  model: modelName.nullable(),
  status: z.enum(['active', 'paused']),
  accessLevel: accessLevelSchema,
};

export const createAgentSchema = z.object({
  key: agentKey,
  name: agentFields.name,
  role: agentFields.role,
  systemPrompt: agentFields.systemPrompt,
  evalCriteria: agentFields.evalCriteria.optional(),
  providerId: agentFields.providerId.optional(),
  model: agentFields.model.optional(),
  status: agentFields.status.optional(),
  accessLevel: agentFields.accessLevel.optional(),
});
export type CreateAgent = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z
  .object(agentFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'không có gì để cập nhật');
export type UpdateAgent = z.infer<typeof updateAgentSchema>;

/** Installs templates by key; an empty list installs every template not installed yet. */
export const installAgentTemplatesSchema = z.object({ keys: z.array(agentKey).max(100).default([]) });
export type InstallAgentTemplates = z.infer<typeof installAgentTemplatesSchema>;

export interface AgentResponse {
  id: string;
  key: string;
  name: string;
  role: string;
  systemPrompt: string;
  evalCriteria: string | null;
  providerId: string | null;
  model: string | null;
  status: 'active' | 'paused';
  templateKey: string | null;
  accessLevel: AccessLevel;
  version: number;
  updatedAt: string;
}

export interface AgentVersionResponse {
  version: number;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface AgentTemplate {
  key: string;
  name: string;
  role: string;
}

/** The initial agent list from the spec (Phần 09). Installed per tenant from the AI Agent page. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  { key: 'tong-dieu-hanh', name: 'AI Tổng điều hành', role: 'Điều phối toàn bộ công việc, giao việc cho các Agent khác và báo cáo cho chủ doanh nghiệp.' },
  { key: 'pho-dieu-hanh', name: 'AI Phó điều hành', role: 'Hỗ trợ Tổng điều hành, theo dõi tiến độ và nhắc việc tồn đọng.' },
  { key: 'lap-ke-hoach', name: 'AI Lập kế hoạch', role: 'Lập kế hoạch chi tiết với mục tiêu, các bước, mốc thời gian, nguồn lực và tiêu chí hoàn thành.' },
  { key: 'nghien-cuu', name: 'AI Nghiên cứu', role: 'Tìm hiểu, tổng hợp và đối chiếu thông tin, nêu rõ mức độ chắc chắn.' },
  { key: 'phan-tich-du-lieu', name: 'AI Phân tích dữ liệu', role: 'Phân tích số liệu kinh doanh, tìm xu hướng và bất thường, đề xuất hành động.' },
  { key: 'nghien-cuu-san-pham', name: 'AI Nghiên cứu sản phẩm', role: 'Nghiên cứu sản phẩm, tính năng, giá và điểm khác biệt so với đối thủ.' },
  { key: 'nghien-cuu-thi-truong', name: 'AI Nghiên cứu thị trường', role: 'Phân tích thị trường, khách hàng mục tiêu, quy mô và đối thủ cạnh tranh.' },
  { key: 'marketing', name: 'AI Marketing', role: 'Xây dựng chiến lược marketing, thông điệp, kênh và lịch triển khai.' },
  { key: 'quang-cao', name: 'AI Quảng cáo', role: 'Lên kế hoạch quảng cáo, nhóm đối tượng, ngân sách và chỉ số đo lường.' },
  { key: 'facebook', name: 'AI Facebook', role: 'Nội dung và chiến dịch cho Facebook, Instagram và Messenger.' },
  { key: 'google', name: 'AI Google', role: 'Chiến dịch Google Ads, Google Business và phân tích Google Analytics.' },
  { key: 'tiktok', name: 'AI TikTok', role: 'Ý tưởng video ngắn, kịch bản và chiến dịch TikTok.' },
  { key: 'youtube', name: 'AI YouTube', role: 'Kịch bản, tiêu đề, mô tả và chiến lược kênh YouTube.' },
  { key: 'website', name: 'AI Website', role: 'Cấu trúc, nội dung và trải nghiệm người dùng cho website.' },
  { key: 'seo', name: 'AI SEO', role: 'Nghiên cứu từ khóa, tối ưu nội dung và kỹ thuật SEO.' },
  { key: 'content', name: 'AI Content', role: 'Lên ý tưởng và lịch nội dung đa kênh.' },
  { key: 'copywriter', name: 'AI Copywriter', role: 'Viết tiêu đề, bài bán hàng và lời kêu gọi hành động thuyết phục.' },
  { key: 'video', name: 'AI Video', role: 'Kịch bản, phân cảnh và hướng dẫn sản xuất video.' },
  { key: 'hinh-anh', name: 'AI Hình ảnh', role: 'Mô tả ý tưởng hình ảnh và viết prompt tạo ảnh.' },
  { key: 'dich-thuat', name: 'AI Dịch thuật', role: 'Dịch chính xác, giữ giọng thương hiệu và thuật ngữ chuyên ngành.' },
  { key: 'giong-doc', name: 'AI Giọng đọc', role: 'Viết lời đọc và hướng dẫn giọng, nhịp, cảm xúc cho lồng tiếng.' },
  { key: 'cham-soc-khach-hang', name: 'AI Chăm sóc khách hàng', role: 'Soạn câu trả lời khách hàng lịch sự, đúng chính sách, và kịch bản xử lý khiếu nại.' },
  { key: 'ban-hang', name: 'AI Bán hàng', role: 'Kịch bản tư vấn, chốt đơn và chăm sóc sau bán.' },
  { key: 'tai-chinh', name: 'AI Tài chính', role: 'Phân tích doanh thu, chi phí, lợi nhuận và dòng tiền.' },
  { key: 'kiem-chung', name: 'AI Kiểm chứng', role: 'Kiểm tra tính đúng đắn của thông tin và chỉ ra điểm cần xác minh.' },
  { key: 'kiem-dinh-chat-luong', name: 'AI Kiểm định chất lượng', role: 'Đánh giá chất lượng sản phẩm đầu ra theo tiêu chí và đề xuất sửa.' },
  { key: 'coach', name: 'AI Coach', role: 'Nhận xét cách làm việc của các Agent và đề xuất cải tiến.' },
  { key: 'memory-keeper', name: 'AI Memory Keeper', role: 'Tóm tắt và đề xuất điều nên lưu vào bộ nhớ dự án.' },
  { key: 'bao-mat', name: 'AI Bảo mật', role: 'Rà soát rủi ro bảo mật, quyền truy cập và bảo vệ dữ liệu.' },
  { key: 'sre', name: 'AI SRE', role: 'Theo dõi độ ổn định hệ thống, sự cố và cách khắc phục.' },
  { key: 'lap-trinh', name: 'AI Lập trình', role: 'Viết, giải thích và sửa mã nguồn.' },
  { key: 'kien-truc', name: 'AI Kiến trúc', role: 'Thiết kế kiến trúc phần mềm, dữ liệu và tích hợp.' },
  { key: 'kiem-thu', name: 'AI Kiểm thử', role: 'Thiết kế ca kiểm thử và tìm lỗi.' },
  { key: 'phat-hanh', name: 'AI Phát hành', role: 'Lập kế hoạch phát hành, danh sách kiểm tra và phương án quay lui.' },
];

export function templatePrompt(t: AgentTemplate): string {
  return `Bạn là ${t.name} trong hệ thống MARIS. Vai trò: ${t.role} Chỉ làm việc trong phạm vi vai trò này; việc ngoài phạm vi thì đề xuất chuyển cho Agent phù hợp.`;
}

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
});
export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'không có gì để cập nhật');
export type UpdateProject = z.infer<typeof updateProjectSchema>;

export interface ProjectResponse {
  id: string;
  name: string;
  description: string | null;
  memoryCount: number;
  updatedAt: string;
}

export const createMemorySchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  pinned: z.boolean().optional(),
});
export type CreateMemory = z.infer<typeof createMemorySchema>;

export const updateMemorySchema = z
  .object({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(4000), pinned: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'không có gì để cập nhật');
export type UpdateMemory = z.infer<typeof updateMemorySchema>;

export interface MemoryResponse {
  id: string;
  projectId: string;
  title: string;
  content: string;
  pinned: boolean;
  updatedAt: string;
}

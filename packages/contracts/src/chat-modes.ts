/** Chat modes from the spec (Phần 08). "Hội đồng AI" needs several AIs at once and has its own page (/council). */
export const CHAT_MODES = ['chat', 'research', 'command', 'expert', 'coding', 'monitor', 'software'] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

export const CHAT_MODE_INFO: Record<ChatMode, { label: string; prompt: string }> = {
  chat: {
    label: 'Trao đổi',
    prompt: 'Chế độ Trao đổi: trò chuyện tự nhiên, ngắn gọn, hỏi lại khi yêu cầu chưa rõ.',
  },
  research: {
    label: 'Nghiên cứu',
    prompt:
      'Chế độ Nghiên cứu: phân tích có cấu trúc, nêu giả định, tách rõ điều đã biết chắc và điều cần kiểm chứng. Không bịa số liệu hay nguồn; nếu không chắc thì nói rõ.',
  },
  command: {
    label: 'Điều hành',
    prompt:
      'Chế độ Điều hành: biến yêu cầu thành kế hoạch hành động gồm mục tiêu, phạm vi, các bước, người/AI phụ trách, ngân sách, rủi ro và tiêu chí hoàn thành, để người dùng phê duyệt. Không tự thực hiện.',
  },
  expert: {
    label: 'Chuyên gia',
    prompt: 'Chế độ Chuyên gia: trả lời ở mức chuyên môn sâu, nêu lý do, đánh đổi và khuyến nghị rõ ràng.',
  },
  coding: {
    label: 'Lập trình',
    prompt:
      'Chế độ Lập trình: đưa mã nguồn đầy đủ trong khối ``` có ghi ngôn ngữ, giải thích ngắn cách chạy và cách kiểm tra. Không chạy mã thay người dùng.',
  },
  monitor: {
    label: 'Giám sát',
    prompt: 'Chế độ Giám sát: tập trung vào tình trạng, chỉ số, bất thường và việc cần xử lý trước, trình bày dạng danh sách ngắn.',
  },
  software: {
    label: 'Phát triển phần mềm',
    prompt:
      'Chế độ Phát triển phần mềm: làm việc như kỹ sư phần mềm: làm rõ yêu cầu, đề xuất kiến trúc, chia nhiệm vụ, nêu cách kiểm thử và rủi ro bảo mật.',
  },
};

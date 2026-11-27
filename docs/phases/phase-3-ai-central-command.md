# Báo cáo nghiệm thu Giai đoạn 3 – AI Central Command

Ngày: 2026-11-27 · Sprint 3–8 · PR #5 đến #12 (đã merge)

Mẫu theo đặc tả Phần 41: mỗi giai đoạn có Mục tiêu, Phạm vi, Danh sách nhiệm vụ, Mã nguồn, Kiểm thử, Tiêu chí nghiệm thu, Báo cáo, Rủi ro, Điều kiện còn thiếu và Phương án rollback.

## 1. Mục tiêu

Xây dựng AI Gateway, AI Chat, Agent, Memory, Router và Failover (Phần 41), cùng AI Tổng điều hành (Phần 06), hệ thống đa AI và AI dự phòng (Phần 07), khung chat (Phần 08), mạng lưới Agent (Phần 09) và Hội đồng AI (Phần 10).

## 2. Phạm vi

Có trong giai đoạn này:

- Kết nối OpenAI, Claude, Gemini, Ollama và mọi API tương thích OpenAI. Key lấy từ Secret Vault.
- Chuyển AI dự phòng khi lỗi, ngắt tạm AI hỏng (circuit breaker), đếm token và chi phí.
- Chat AI có 7 chế độ, đính kèm ảnh và văn bản, nhập bằng giọng nói.
- 34 AI Agent mẫu, có phiên bản và mức quyền.
- Bộ nhớ dự án, Danh mục model và khả năng, Hội đồng AI.
- Giao việc có phê duyệt, Dừng khẩn cấp, ngân sách tháng.
- AI Tổng điều hành: từ mục tiêu ra kế hoạch, công việc và báo cáo.

Không có trong giai đoạn này: AI không thực hiện hành động bên ngoài (đăng bài, gửi tin, chi tiền, sửa dữ liệu). Mọi kết quả là văn bản.

## 3. Danh sách nhiệm vụ

| Sprint | Nội dung | PR |
| --- | --- | --- |
| 3 | AI Gateway, Router, failover, circuit breaker, Chat SSE, chống SSRF | #5, #6 |
| 4 | AI Agent (34 mẫu, phiên bản), 7 chế độ chat, bộ nhớ dự án, Markdown | #7 |
| 5 | Structured Task có phê duyệt, Dừng khẩn cấp, Cost Governor | #8, #9 |
| 6 | Model Registry và khả năng, Hội đồng AI | #10 |
| 7 | Tải tệp (ảnh, văn bản cho AI đọc), nhập bằng giọng nói | #11 |
| 8 | AI Tổng điều hành (kế hoạch → công việc → báo cáo), mức quyền Agent | #12 |

## 4. Mã nguồn

- API: `apps/api/src/ai/`, `apps/api/src/files/`
- Hợp đồng dữ liệu (Zod): `packages/contracts/src/` (ai, agents, tasks, models, council, files, access-levels, command)
- Migration: `packages/db/migrations/0003` đến `0008`
- Web: `/chat`, `/ai`, `/agents`, `/memory`, `/tasks`, `/council`, `/command`

## 5. Kiểm thử

`pnpm build && pnpm typecheck && pnpm test`: 122/122 test qua khi kết thúc Sprint 8, CI xanh trên GitHub. Các test e2e chạy với AI giả (`apps/api/test/fake-ai.ts`), nên không tốn tiền và không gọi nhà cung cấp thật.

Những điều đã có test:

- Failover và circuit breaker
- Chặn SSRF
- Cách ly tenant bằng RLS
- Quyền theo vai trò
- Phê duyệt công việc, Dừng khẩn cấp, ngân sách
- Prompt injection qua tệp, bộ nhớ và câu trả lời của AI khác (được rào bằng thẻ)
- Phát hiện loại tệp
- Kiểm tra kế hoạch do AI trả về

Đã thử thật trên máy chủ doanh nghiệp với OpenAI `gpt-4o-mini`: chat, giao việc, giá và chi phí, tải ảnh, AI Tổng điều hành từ đầu đến báo cáo.

## 6. Tiêu chí nghiệm thu

| Tiêu chí | Kết quả |
| --- | --- |
| Chat được với AI thật, có AI dự phòng khi AI chính lỗi | Đạt |
| Key không bao giờ hiện ra trình duyệt, nhật ký hay chat | Đạt (Secret Vault, che key trong lỗi) |
| AI không thực hiện hành động bên ngoài khi chưa được duyệt | Đạt (công việc chỉ chạy sau khi duyệt; chỉ soạn văn bản) |
| Dừng khẩn cấp ngắt mọi AI đang chạy | Đạt (khoảng 0,5 giây) |
| Chi phí được đếm và chặn khi hết ngân sách | Đạt (cần nhập giá cho AI/model) |
| AI không tự nâng quyền | Đạt (chỉ `ai.manage` đổi mức quyền, có audit) |
| Dữ liệu tenant tách biệt | Đạt (FORCE RLS, test e2e) |

## 7. Báo cáo

Giai đoạn 3 hoàn thành các mục chính. Chủ hệ thống đã dùng thử trên máy của mình ngày 2026-11-27.

## 8. Rủi ro

- Chi phí chỉ đúng khi người dùng nhập giá. Thiếu giá thì chi phí tính là 0 và ngân sách không chặn được.
- Một lượt AI đang chạy có thể vượt ngân sách một chút, vì giới hạn được kiểm tra trước mỗi lượt.
- Báo cáo của AI Tổng điều hành chỉ tổng hợp những gì AI đã viết. Số liệu thị trường là AI suy đoán, cần kiểm chứng.
- Nhận dạng giọng nói gửi âm thanh tới dịch vụ của hãng trình duyệt, không qua MARIS.
- Tệp tải lên nằm trên ổ đĩa máy chủ. Mất ổ đĩa là mất tệp nếu không sao lưu `data/uploads`.

## 9. Điều kiện còn thiếu

- AI chưa đọc được PDF, Word, Excel; chưa chép lời video và âm thanh.
- Chưa có vòng lặp tự cải tiến của Hội đồng AI (Planner → Worker → Grader).
- Kế hoạch của AI Tổng điều hành chưa sửa được từng bước và chưa có thứ tự phụ thuộc giữa các bước.
- AI Tổng điều hành chưa chọn được Skill, Workflow, Worker. Các phần này thuộc Giai đoạn 4–5.
- Mục nhỏ còn lại của Giai đoạn 2:
  - Gửi email lời mời
  - Song ngữ vi/en
  - Xoay vòng khóa `VAULT_MASTER_KEY`

## 10. Phương án rollback

- **Mã nguồn:** quay về commit trước của `main` (`git checkout <commit>`, `pnpm install`, `pnpm build`), rồi chạy lại API và web.
- **Database:** migration chỉ đi tiến. Các migration 0003–0008 chỉ thêm bảng và cột, không xóa dữ liệu cũ, nên mã cũ vẫn chạy được trên database mới. Muốn trả database về đúng trạng thái trước thì khôi phục từ bản sao lưu PostgreSQL (`pg_dump`) chụp trước khi migrate.
- **Tắt nhanh mà không cần rollback:**
  - Bấm Dừng khẩn cấp để chặn mọi AI.
  - Đặt `AI_TASK_WORKER_ENABLED=false` để không chạy công việc, Hội đồng và kế hoạch.
  - Tắt từng AI Provider hoặc model trên trang AI Provider.

# Trạng thái dự án

Cập nhật: 2026-11-27 · Giai đoạn hiện tại: **3 – AI Central Command (Sprint 6)**

| Giai đoạn | Trạng thái |
| --- | --- |
| 0–1. Audit và Architecture | Xong (báo cáo đã duyệt Q1–Q6) |
| 2. Core Platform | Sprint 1, 2 và màn hình quản trị đã merge; còn vài mục nhỏ (bên dưới) |
| 3. AI Central Command | Sprint 3, 4, 5 đã merge; Sprint 6 (Hội đồng AI, Danh mục model) đang review; còn tải tệp và giọng nói (Sprint 7) |
| 4–14 | Chưa bắt đầu |

## Sprint 1 (đã merge)

- Monorepo pnpm + Turborepo, Docker Compose (PostgreSQL 16 + pgvector, Redis, MinIO)
- Migration `0001`: schema `identity`, `security`, Row-Level Security theo tenant, role runtime `maris_app`
- Bootstrap Owner, đăng nhập, khóa tài khoản, MFA TOTP, Tenant qua `X-Tenant-Id`, RBAC 4 vai trò, audit log chuỗi hash
- Web: đăng nhập, khung giao diện 5 vùng; CI đầy đủ

## Sprint 2

- Migration `0002`: lời mời, Secret Vault, outbox, quyền `secrets.read` / `secrets.manage`
- Mời thành viên (token dùng một lần, 7 ngày), chấp nhận lời mời, đổi vai trò, gỡ thành viên
- Secret Vault chỉ ghi: `POST/GET/DELETE /api/v1/secrets`, trả về `secret://<id>`
- Outbox → BullMQ `maris-events`
- Rate limit trên Redis (toàn API, đăng nhập, chấp nhận lời mời, MFA)
- Phiên trình duyệt bằng cookie httpOnly + header chống CSRF; web không còn giữ token

## Màn hình quản trị (web)

- `/secrets`: thêm, xem danh sách, xóa key; giá trị không bao giờ hiển thị lại
- `/members`: mời (đường dẫn `/invite#token`, token nằm sau `#` nên không đi vào log máy chủ), đổi vai trò, gỡ, hủy lời mời
- `/invite`: người được mời đặt tên và mật khẩu, hoặc đăng nhập nếu đã có tài khoản

## Còn lại của Giai đoạn 2

- Gửi email lời mời (hiện Owner tự chia sẻ đường dẫn/token)
- next-intl (vi, en); audit cho sự kiện cấp người dùng (đăng nhập, bật MFA)
- Xoay vòng khóa `VAULT_MASTER_KEY` (cột `key_version` đã có)

## Sprint 3 – AI Gateway và AI Chat (Giai đoạn 3)

- Migration `0003`: schema `ai` (providers, conversations, messages, provider_calls), quyền `ai.chat` (mọi vai trò mặc định) và `ai.manage` (owner, administrator)
- Universal AI Provider Gateway: OpenAI, Anthropic (Claude), Gemini, Ollama, mọi API tương thích OpenAI (OpenRouter, DeepSeek, Qwen, Grok). Key lấy từ Secret Vault theo `secret://`
- AI Router: thứ tự dự phòng chỉnh trên giao diện, retry + backoff cho lỗi tạm thời, timeout theo thời gian im lặng, circuit breaker trên Redis (3 lỗi/60 giây → bỏ qua 30 giây). Chỉ chuyển AI trước khi có chữ đầu tiên; lỗi 400 không chuyển AI
- Chống SSRF cho base URL (https công khai; Ollama loopback; `AI_ALLOW_PRIVATE_URLS` cho mạng nội bộ), không theo redirect
- AI Chat: hội thoại riêng từng người (RLS theo user), stream SSE, dừng giữa chừng, lịch sử làm ngữ cảnh, system prompt không cho thực thi hành động
- Token và chi phí: ghi mỗi lượt gọi (kể cả lỗi) vào `ai.provider_calls`, giá theo USD/1 triệu token do người dùng nhập; `GET /api/v1/ai/usage`
- Web: `/chat`, `/ai` (AI Provider), khung AI Chat bên phải mọi trang

## Sprint 4 – AI Agent, chế độ chat, bộ nhớ dự án (Giai đoạn 3)

- Migration `0004`: `ai.agents` + `ai.agent_versions` (mỗi lần sửa lưu một phiên bản), `ai.projects`, `ai.memories`, cột `agent_id` / `project_id` / `mode` cho hội thoại; quyền mới `ai.memory` (owner, administrator, manager)
- AI Agent: tên, vai trò, prompt, Provider/Model riêng, tiêu chí đánh giá, trạng thái, phiên bản. 34 Agent mẫu theo Phần 09 cài bằng một nút (chạy lại không tạo trùng)
- Chế độ chat: Trao đổi, Nghiên cứu, Điều hành, Chuyên gia, Lập trình, Giám sát, Phát triển phần mềm
- Bộ nhớ dự án lưu trong MARIS (không phụ thuộc AI Provider), mục ghim đọc trước, tối đa 16.000 ký tự mỗi lượt; được rào trong `<project_memory>` và luôn đứng sau quy tắc an toàn của MARIS
- Thứ tự chọn AI: Provider chọn trong hội thoại > Provider của Agent > thứ tự dự phòng
- Web: `/agents`, `/memory`; chọn Agent, chế độ, dự án trong Chat; câu trả lời hiển thị chữ đậm, danh sách, mã (không chèn HTML thô)

## Sprint 5 – Giao việc có phê duyệt, Dừng khẩn cấp, Cost Governor (Giai đoạn 3)

- Migration `0005`: `ai.tasks`, `ai.budgets`, `ai.controls`, cột `task_id` cho `ai.provider_calls`; quyền mới `ai.approve` (owner, administrator)
- Structured Task: mục tiêu, phạm vi, quyền hạn (hiện chỉ `ai.generate_text`), ngân sách USD, tiêu chí hoàn thành, Agent, dự án. Chờ duyệt → duyệt → chạy trên hàng đợi BullMQ `maris-tasks` → hoàn thành / lỗi. Tạm dừng, chạy tiếp (cần `ai.approve`), hủy (người tạo hoặc người duyệt). Lấy công việc bằng `UPDATE … WHERE status='queued'` nên job trùng không chạy hai lần
- Dừng khẩn cấp: ai có `ai.chat` đều bấm được; chặn chat (HTTP 423) và duyệt việc, ngắt câu trả lời và công việc đang chạy trong khoảng 0,5 giây (cờ Redis), chuyển việc đang mở sang tạm dừng; chỉ `ai.approve` bật lại
- Cost Governor: ngân sách tháng (UTC) cho toàn tenant hoặc từng Provider; 80% gửi sự kiện `ai.budget.threshold_reached` một lần mỗi tháng; Provider hết ngân sách bị bỏ qua (chuyển AI dự phòng); tenant hết ngân sách thì chặn mọi AI (HTTP 402)
- Web: `/tasks`, nút “Giao việc” dưới câu trả lời trong chat, thanh Công việc đang chạy cập nhật mỗi 5 giây, nút Dừng khẩn cấp, ô ngân sách trên trang AI Provider
- Giới hạn: ngân sách của một công việc được kiểm tra trước mỗi lần chạy (một lần chạy có thể vượt một chút); nếu API dừng giữa lúc duyệt và lúc đưa vào hàng đợi, công việc nằm ở “chờ chạy” cho tới khi bấm Tạm dừng rồi Chạy tiếp

## Sprint 6 – Danh mục model và Hội đồng AI (Giai đoạn 3)

- Migration `0006`: `ai.models`, `ai.councils`, `ai.council_turns` (chỉ INSERT), cột `council_id` cho `ai.provider_calls`
- Model Registry và Capability Registry: mỗi model của một AI có khả năng (trò chuyện, suy luận sâu, lập trình, ngữ cảnh dài, đọc hình ảnh, nhanh, giá rẻ), giá riêng, ngữ cảnh tối đa, bật/tắt. Chế độ Lập trình và Phát triển phần mềm ưu tiên model “Lập trình”; Nghiên cứu, Chuyên gia và Giao việc ưu tiên “Suy luận sâu”. Model do người dùng hoặc Agent chọn thì giữ nguyên. Model tắt không bao giờ được dùng. Giá model thay giá AI khi tính chi phí và ngân sách
- Hội đồng AI (`/council`): 2–4 thành viên (AI + model) trả lời độc lập song song → phản biện lẫn nhau (tùy chọn, cần ít nhất 2 câu trả lời) → một AI tổng hợp (các thành viên khác là dự phòng). Giới hạn chi phí mỗi phiên kiểm tra trước mỗi bước; hủy bởi người tạo hoặc người duyệt; Dừng khẩn cấp ngắt phiên đang họp. Bản tổng hợp tách đồng thuận và bất đồng, và ghi rõ đồng thuận không phải bằng chứng (đặc tả Phần 10)
- Chạy trên hàng đợi BullMQ `maris-council`, cùng cờ `AI_TASK_WORKER_ENABLED`
- Giới hạn: một bước đang chạy có thể vượt giới hạn chi phí một chút vì giới hạn được kiểm tra giữa các bước; vòng lặp tự cải tiến (Planner → Worker → Grader → …) chưa làm

## Sprint 7 (dự kiến, Giai đoạn 3)

- Tải hình ảnh, video, tài liệu. Máy của người dùng không tải được image `minio/minio` từ Docker Hub, nên cần lưu tệp trên ổ đĩa cục bộ trước, MinIO/S3 sau
- Nhập liệu bằng giọng nói

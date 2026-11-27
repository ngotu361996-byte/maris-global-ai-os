# Trạng thái dự án

Cập nhật: 2026-11-27 · Giai đoạn hiện tại: **3 – AI Central Command (Sprint 3)**

| Giai đoạn | Trạng thái |
| --- | --- |
| 0–1. Audit và Architecture | Xong (báo cáo đã duyệt Q1–Q6) |
| 2. Core Platform | Sprint 1, 2 và màn hình quản trị đã merge; còn vài mục nhỏ (bên dưới) |
| 3. AI Central Command | Sprint 3 (AI Gateway, Router, Chat) đang review; Sprint 4 chưa bắt đầu |
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

## Sprint 4 (dự kiến, Giai đoạn 3)

- AI Agent (cấu hình độc lập), chế độ chat (Trao đổi, Nghiên cứu, Điều hành…)
- Bộ nhớ theo dự án, Structured Task có phê duyệt, Dừng khẩn cấp
- Cost Governor: ngân sách theo Provider/Tenant, cảnh báo 80%, Capability/Model Registry
- Tải tệp, giọng nói

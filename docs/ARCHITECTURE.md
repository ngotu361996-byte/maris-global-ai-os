# Kiến trúc

Modular Monolith: một ứng dụng NestJS (`apps/api`) chứa mọi module, ranh giới rõ theo thư mục;
một ứng dụng Next.js (`apps/web`) cho Web, Mobile Responsive và Desktop (Tauri bọc cùng mã, Giai đoạn 11).

## Luồng một request có tenant

1. `AuthGuard`: `Authorization: Bearer <token>` → băm SHA-256 → tra `identity.sessions` còn hạn.
2. `TenantGuard`: đọc `X-Tenant-Id`, kiểm tra người dùng là thành viên tenant đó, nạp quyền của vai trò, kiểm tra `@RequirePermission`.
3. Service gọi `DbService.withContext({ userId, tenantId })`: mở transaction, `set_config('app.tenant_id', …, true)` (tương đương SET LOCAL), mọi truy vấn chịu RLS.
4. Thay đổi dữ liệu ghi `security.audit_logs` trong cùng transaction.

## Sự kiện (outbox)

Thay đổi nghiệp vụ ghi một dòng vào `work.outbox_events` trong cùng transaction. `OutboxService` (mỗi giây) chuyển các dòng chưa gửi
sang hàng đợi BullMQ `maris-events` với `jobId` = id sự kiện, rồi đánh dấu đã gửi. Sự kiện có thể đến hơn một lần, nên consumer phải idempotent.
Tên sự kiện: `<module>.<đối tượng>.<quá khứ>`, ví dụ `identity.member.added`, `security.secret.created`.

## AI Gateway (Giai đoạn 3)

`apps/api/src/ai`: mỗi loại nhà cung cấp là một adapter (`adapters.ts`) đổi lịch sử chat chung sang API riêng và đọc stream SSE về
dạng chữ + token. `AiRouterService` thử lần lượt các provider đang bật theo `priority` (provider được chọn cho hội thoại đứng đầu):
lỗi tạm thời (429, 5xx, mạng, timeout) thử lại một lần với backoff rồi chuyển provider; 401/403 chuyển provider ngay; 400 dừng
(không dùng provider khác để né từ chối). Khi đã có chữ gửi tới người dùng thì không chuyển nữa, để không trả lời hai lần.
Circuit breaker lưu trên Redis nên mọi instance API cùng thấy. Key chỉ được giải mã ngay trước lượt gọi và không rời máy chủ.

Gửi tin nhắn: transaction 1 ghi tin người dùng + chỗ trống cho câu trả lời + audit; stream không giữ transaction;
transaction 2 ghi câu trả lời, mọi lượt gọi provider và sự kiện `ai.message.completed`.

## Dữ liệu

- PostgreSQL 16, mỗi module một schema. Hiện có `identity`, `security`, `work`, `ai`, `maris_ctx` (hàm ngữ cảnh).
- Khóa chính UUIDv7 sinh ở ứng dụng.
- File SQL trong `packages/db/migrations` là nguồn chuẩn; `schema.ts` (Drizzle) phản chiếu để truy vấn có kiểu.

## Quyết định

Xem `docs/adr/`.

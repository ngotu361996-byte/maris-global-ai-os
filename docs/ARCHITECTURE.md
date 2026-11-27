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

## Dữ liệu

- PostgreSQL 16, mỗi module một schema. Hiện có `identity`, `security`, `work`, `maris_ctx` (hàm ngữ cảnh).
- Khóa chính UUIDv7 sinh ở ứng dụng.
- File SQL trong `packages/db/migrations` là nguồn chuẩn; `schema.ts` (Drizzle) phản chiếu để truy vấn có kiểu.

## Quyết định

Xem `docs/adr/`.

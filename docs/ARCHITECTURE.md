# Kiến trúc

Modular Monolith: một ứng dụng NestJS (`apps/api`) chứa mọi module, ranh giới rõ theo thư mục;
một ứng dụng Next.js (`apps/web`) cho Web, Mobile Responsive và Desktop (Tauri bọc cùng mã, Giai đoạn 11).

## Luồng một request có tenant

1. `AuthGuard`: `Authorization: Bearer <token>` → băm SHA-256 → tra `identity.sessions` còn hạn.
2. `TenantGuard`: đọc `X-Tenant-Id`, kiểm tra người dùng là thành viên tenant đó, nạp quyền của vai trò, kiểm tra `@RequirePermission`.
3. Service gọi `DbService.withContext({ userId, tenantId })`: mở transaction, `set_config('app.tenant_id', …, true)` (tương đương SET LOCAL), mọi truy vấn chịu RLS.
4. Thay đổi dữ liệu ghi `security.audit_logs` trong cùng transaction.

## Dữ liệu

- PostgreSQL 16, mỗi module một schema. Sprint 1 có `identity`, `security`, `maris_ctx` (hàm ngữ cảnh).
- Khóa chính UUIDv7 sinh ở ứng dụng.
- File SQL trong `packages/db/migrations` là nguồn chuẩn; `schema.ts` (Drizzle) phản chiếu để truy vấn có kiểu.

## Quyết định

Xem `docs/adr/`.

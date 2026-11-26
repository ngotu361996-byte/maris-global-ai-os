# Hướng dẫn cho AI lập trình

- Đọc `PROJECT_STATUS.md` và `docs/ARCHITECTURE.md` trước khi sửa.
- Đặc tả chính thức: MARIS Enterprise 10.0. Không thêm tính năng ngoài giai đoạn đang làm.
- DDL và RLS chỉ thay đổi bằng file migration mới trong `packages/db/migrations` (không sửa file đã chạy). Cập nhật `packages/db/src/schema.ts` cho khớp.
- Mọi truy vấn dữ liệu tenant đi qua `DbService.withContext` với tenant đã được `TenantGuard` xác minh.
- Hành động thay đổi dữ liệu nghiệp vụ phải ghi `AuditService.append` trong cùng transaction.
- Endpoint mới: schema Zod ở `packages/contracts`, guard `AuthGuard` + `TenantGuard` + `@RequirePermission`.
- Không commit secret, không tắt test, không hạ mức kiểm tra để CI xanh.
- Chạy `pnpm build && pnpm typecheck && pnpm test` trước khi mở PR.

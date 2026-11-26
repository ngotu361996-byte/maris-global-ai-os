# Trạng thái dự án

Cập nhật: 2026-11-27 · Giai đoạn hiện tại: **2 – Core Platform (Sprint 1)**

| Giai đoạn | Trạng thái |
| --- | --- |
| 0–1. Audit và Architecture | Xong (báo cáo đã duyệt Q1–Q6) |
| 2. Core Platform | Đang làm: Sprint 1 |
| 3–14 | Chưa bắt đầu |

## Sprint 1 đã có

- Monorepo pnpm + Turborepo, Docker Compose (PostgreSQL 16 + pgvector, Redis, MinIO)
- Migration `0001`: schema `identity`, `security`, Row-Level Security theo tenant, role runtime `maris_app`
- API: bootstrap Owner (một lần), đăng nhập, khóa tài khoản sau 5 lần sai, phiên token băm SHA-256, MFA TOTP (secret mã hóa AES-256-GCM)
- Tenant hiện hành qua `X-Tenant-Id` (kiểm tra thành viên phía server), RBAC 4 vai trò mặc định, chặn tự nâng quyền
- Audit log append-only với chuỗi hash và API kiểm tra toàn vẹn
- Web: đăng nhập, khởi tạo, khung giao diện 5 vùng, Dark/Light, tiếng Việt
- CI: gitleaks, build, typecheck, migrate, test e2e trên Postgres thật, pnpm audit

## Chưa làm (Sprint 2)

- Mời thành viên, đổi vai trò, gỡ thành viên
- Secret Vault, Queue (BullMQ), rate limit, API Gateway
- Chuyển token sang cookie httpOnly; next-intl (vi, en)
- Audit cho sự kiện cấp người dùng (MFA bật/tắt, đăng nhập)

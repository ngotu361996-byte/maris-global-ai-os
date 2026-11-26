# MARIS Global AI Business OS

Nền tảng điều hành doanh nghiệp bằng AI, xây theo đặc tả **MARIS Enterprise 10.0**.
Kiến trúc: Modular Monolith (NestJS + Next.js + PostgreSQL + Redis/BullMQ + MinIO), monorepo pnpm + Turborepo.

Trạng thái hiện tại: xem [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Cấu trúc

```
apps/api          NestJS API (/api/v1): auth, MFA, tenant, RBAC, audit
apps/web          Next.js: giao diện Command Center 5 vùng
packages/contracts  Schema Zod + kiểu dữ liệu dùng chung cho API và web
packages/db       Migration SQL (nguồn chuẩn cho DDL + RLS), schema Drizzle, UUIDv7
infra/            Script khởi tạo Postgres cho Development
docs/             Kiến trúc, ADR
```

## Chạy trên Windows (Development)

Cần: Git, Node 22, pnpm 10 (`corepack enable`), Docker Desktop.

> Đặt repo **ngoài OneDrive**, ví dụ `C:\dev\maris-global-ai-os`. OneDrive đồng bộ làm hỏng `.git` và `node_modules`.

```powershell
git clone https://github.com/ngotu361996-byte/maris-global-ai-os C:\dev\maris-global-ai-os
cd C:\dev\maris-global-ai-os
copy .env.example .env
# Sinh khóa MFA rồi dán vào MFA_ENCRYPTION_KEY trong .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
docker compose up -d
pnpm install
pnpm build
$env:DATABASE_ADMIN_URL="postgres://maris:maris_dev@localhost:5432/maris"; pnpm db:migrate
pnpm dev
```

Mở http://localhost:3000, chọn **Khởi tạo chủ hệ thống** để tạo tài khoản Owner và Tenant đầu tiên (chỉ làm được một lần).

## Kiểm thử

```bash
pnpm test       # unit + e2e (e2e cần Postgres đang chạy và đã tạo role maris_app)
pnpm typecheck
```

## Nguyên tắc bắt buộc

- Không bao giờ commit secret. API key chỉ vào Secret Vault, không dán vào chat hay code.
- Mọi bảng nghiệp vụ có `tenant_id` và Row-Level Security; API chạy bằng role `maris_app` không có quyền vượt RLS.
- `security.audit_logs` chỉ được INSERT, có chuỗi hash; `GET /api/v1/audit-logs/verify` kiểm tra toàn vẹn.
- Giao diện không điền số mẫu: chưa có dữ liệu thì hiển thị “Chưa kết nối”.

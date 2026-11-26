# ADR 0001: Modular Monolith, NestJS + Next.js + PostgreSQL

- Ngày: 2026-11-26
- Trạng thái: Đã duyệt (Q1 trong báo cáo Giai đoạn 0–1)

## Bối cảnh

40 trung tâm chức năng, 1 kỹ sư + AI lập trình. Microservices tăng chi phí vận hành và độ phức tạp triển khai quá sớm.

## Quyết định

Một API NestJS chia module, một PostgreSQL chia schema, Redis/BullMQ cho hàng đợi, MinIO cho media, Tauri 2 cho Desktop.
Tách module ra service riêng chỉ khi có số đo tải thực tế chứng minh cần.

## Hệ quả

- Triển khai đơn giản (một image API, một image web).
- Ranh giới module phải giữ bằng quy ước và review: module không truy vấn trực tiếp bảng của module khác.

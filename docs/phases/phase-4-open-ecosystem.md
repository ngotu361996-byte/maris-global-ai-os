# Báo cáo nghiệm thu Giai đoạn 4 – Open Ecosystem

Ngày: 2026-11-27 · Sprint 9–12 · PR #13, #14, #15 (đã merge) và PR Sprint 12

Mẫu theo đặc tả Phần 41: Mục tiêu, Phạm vi, Danh sách nhiệm vụ, Mã nguồn, Kiểm thử, Tiêu chí nghiệm thu, Báo cáo, Rủi ro, Điều kiện còn thiếu, Phương án rollback.

## 1. Mục tiêu

Xây dựng Plugin Engine, Skill Engine, Extension SDK, Connector Hub và Workflow Studio (Phần 41). Phần chi tiết theo:

- Workflow Studio: Phần 22
- App Center, Plugin và Skill: Phần 23
- Connector Hub: Phần 24

## 2. Phạm vi

Có trong giai đoạn này:

- **Skill:** việc AI làm lặp lại, đóng gói sẵn. Có ô nhập, hướng dẫn, tiêu chí đạt, mức quyền, ngân sách và thời gian. Xuất và nhập được bằng tệp có checksum.
- **Workflow Studio:** dây chuyền nhiều bước, gồm các bước AI, Skill, Connector, Điều kiện, Duyệt, Chờ và Điểm lưu. Workflow có phiên bản, chạy thử miễn phí, chạy thật trong ngân sách, và chạy tiếp được sau lỗi.
- **Connector Hub:**
  - Gọi API REST với khóa lấy từ Secret Vault.
  - Mỗi thao tác khai báo mức rủi ro.
  - Chống SSRF, có nhật ký gọi.
  - Nhận Webhook có mã bí mật.
- **Plugin Engine (App Center):**
  - Gói Skill, Connector và Workflow vào một bản khai có chữ ký Ed25519.
  - Thao tác: cài, kích hoạt, tạm dừng, cập nhật, quay về phiên bản cũ, thu hồi, gỡ.
  - Kiểm tra quyền, phụ thuộc và tương thích.
  - Quản lý danh sách nhà phát hành tin cậy.
- **Extension SDK:** gói `@maris/sdk` và lệnh `pnpm ext` để đóng gói, ký và kiểm tra Plugin.
- **Extension API:** các endpoint REST `/api/v1/plugins`.

Không có trong giai đoạn này:

- Plugin và bước Workflow chạy mã. Phần này cần sandbox ở Giai đoạn 5.
- OAuth, MCP Gateway, CLI Adapter, Local Worker.
- Kho Plugin chung.

## 3. Danh sách nhiệm vụ

| Sprint | Nội dung | PR |
| --- | --- | --- |
| 9 | Skill: tạo, sửa (tăng phiên bản), chạy thành công việc chờ duyệt, xuất/nhập, 6 Skill mẫu | #13 |
| 10 | Workflow Studio: phiên bản, chạy thử, chạy thật, duyệt, điểm lưu, ngân sách lần chạy | #14 |
| 11 | Connector Hub: thao tác, Secret Vault, chống SSRF, bước Connector, Webhook, 4 mẫu | #15 |
| 12 | Plugin Engine, chữ ký, nhà phát hành tin cậy, Extension SDK, trang Trung tâm Plugin | Sprint 12 |

## 4. Mã nguồn

- **API:**
  - `apps/api/src/ai/skills.service.ts`
  - `apps/api/src/workflows/`
  - `apps/api/src/connectors/`
  - `apps/api/src/plugins/`
- **Hợp đồng dữ liệu (Zod):** `packages/contracts/src/` (skills, workflows, connectors, plugins)
- **Extension SDK:** `packages/sdk/`. Hướng dẫn: `docs/EXTENSION_SDK.md`
- **Migration:** `packages/db/migrations/0009` đến `0012`
- **Web:** `/skills`, `/workflows`, `/connectors`, `/plugins`

## 5. Kiểm thử

Lệnh `pnpm build && pnpm typecheck && pnpm test` cho kết quả:

- 170 test của API qua, gồm 5 test e2e mới cho Plugin.
- 4 test của SDK qua.
- CI xanh trên GitHub.

Những điều đã có test:

- **Skill:** ô nhập, placeholder, checksum khi nhập.
- **Workflow:**
  - Vòng lặp bị chặn ở giới hạn bước.
  - Ngân sách là trần, mỗi bước nhận phần còn lại.
  - Duyệt và từ chối, chạy tiếp từ điểm lưu, hủy.
- **Connector:**
  - Ô nhập không thoát khỏi đoạn đường dẫn hay chuỗi JSON.
  - Khóa bị che trong nhật ký.
  - Địa chỉ nội bộ bị chặn cả khi đổi DNS.
  - Webhook sai mã bị từ chối.
- **Plugin:**
  - Từ chối tệp bị sửa sau khi đóng gói, tệp xin thiếu quyền, tệp có bài kiểm tra trượt, và mã trùng với thành phần không thuộc Plugin.
  - Chữ ký giả mạo, tức cùng mã khóa nhưng khác khóa, bị từ chối.
  - Thôi tin cậy một khóa thì Plugin do khóa đó ký bị tạm dừng.
  - Phụ thuộc sai phiên bản chặn kích hoạt. Plugin đang được phụ thuộc thì không gỡ được.
  - Thu hồi là tắt hẳn. Gỡ là xóa cả thành phần.
  - Mọi thao tác ghi audit.

Đã thử thật trên máy chủ doanh nghiệp:

- Skill và Workflow với OpenAI `gpt-4o-mini`.
- Trang Connector sau khi cập nhật Sprint 11.

## 6. Tiêu chí nghiệm thu

| Tiêu chí | Kết quả |
| --- | --- |
| Mỗi Extension có Manifest, ID, Version, Description, Author, Permissions, Dependencies, Compatibility, Input/Output Schema, Resource Budget, Timeout, Signature, Test Suite (Phần 23) | Đạt. Input/Output Schema là của từng thành phần |
| Cài, gỡ, kích hoạt, tạm dừng, cập nhật ứng dụng | Đạt |
| Tạo Plugin, Skill, Connector, Workflow; nhập và xuất Skill | Đạt. Agent đã có từ Giai đoạn 3 |
| Plugin không truy cập Database lõi ngoài phạm vi | Đạt. Plugin chỉ là khai báo, không có mã chạy |
| Kiểm tra mã nguồn, phụ thuộc, chữ ký, quyền trước khi kích hoạt | Đạt. Không có mã để kiểm, chỉ có khai báo |
| Thu hồi ứng dụng không an toàn | Đạt |
| Hỗ trợ Sandbox | Chưa. Chờ Giai đoạn 5, khi Plugin có mã chạy |
| AI không hành động bên ngoài khi chưa được duyệt | Đạt. Kích hoạt Connector, thao tác gửi ra ngoài và chạy Workflow đều cần `ai.approve` |
| Dữ liệu tenant tách biệt | Đạt. FORCE RLS trên mọi bảng mới |

## 7. Báo cáo

Giai đoạn 4 hoàn thành các mục chính của Phần 23 đến 24 cho phần mở rộng dạng khai báo. Chủ hệ thống đã dùng thử Skill, Workflow và Connector trên máy của mình ngày 2026-11-27.

## 8. Rủi ro

- **Plugin chưa ký:** vẫn bật được khi người duyệt chấp nhận. An toàn phụ thuộc vào việc người duyệt đọc kỹ quyền. Lần chấp nhận nào cũng được ghi audit.
- **Khóa riêng của nhà phát hành:** nếu lộ, kẻ xấu ký được Plugin. Cách xử lý là thôi tin cậy khóa đó, vì việc này tạm dừng ngay các Plugin do khóa đó ký.
- **Connector gửi ra ngoài:** trong Workflow không tự thử lại để tránh gửi trùng, nên lỗi mạng làm bước đó thất bại.
- **Chi phí:** chỉ đúng khi đã nhập giá model, giống Giai đoạn 3.
- **Bài kiểm tra:** chỉ chạy thử. Chúng không chứng minh dịch vụ bên ngoài hoạt động.

## 9. Điều kiện còn thiếu

- Sandbox cho Plugin chạy mã, Worker, GPU. Các phần này thuộc Giai đoạn 5.
- OAuth, MCP Gateway, CLI Adapter, Local Worker cho Connector.
- Thiết kế Workflow bằng kéo thả. Các bước Hẹn giờ, Song song, Gộp, Thông báo.
- Kho Plugin chung, tự cập nhật Plugin, Plugin chứa Agent.
- Mục nhỏ còn lại của Giai đoạn 2: gửi email lời mời, song ngữ vi/en, xoay vòng khóa `VAULT_MASTER_KEY`.

## 10. Phương án rollback

- **Mã nguồn:** quay về commit trước của `main` (`git checkout <commit>`, `pnpm install`, `pnpm build`), rồi chạy lại API và web.
- **Database:** migration chỉ đi tiến. Các migration 0009 đến 0012 chỉ thêm schema, bảng và cột, nên mã cũ vẫn chạy trên database mới. Muốn trả về đúng trạng thái trước thì khôi phục bản `pg_dump` chụp trước khi migrate.
- **Tắt nhanh mà không cần rollback:**
  - Bấm Dừng khẩn cấp để chặn mọi AI và mọi lần gọi Connector.
  - Tạm dừng hoặc Thu hồi từng Plugin.
  - Tạm tắt từng Connector.
  - Thôi tin cậy một khóa nhà phát hành.

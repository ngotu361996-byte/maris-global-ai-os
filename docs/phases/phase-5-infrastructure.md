# Báo cáo nghiệm thu Giai đoạn 5 – Hạ tầng

Ngày: 2026-11-27 · Sprint 13–15 · PR #18, #19 (đã merge) và PR Sprint 15

Mẫu theo đặc tả Phần 41: Mục tiêu, Phạm vi, Danh sách nhiệm vụ, Mã nguồn, Kiểm thử, Tiêu chí nghiệm thu, Báo cáo, Rủi ro, Điều kiện còn thiếu, Phương án rollback.

## 1. Mục tiêu

Đưa máy tính, VPS và GPU vào MARIS một cách an toàn (Phần 26): ghép nối thiết bị, theo dõi tài nguyên, phân việc cho Worker, chạy mã trong sandbox trên máy Code Runner, và giám sát toàn hệ thống (API, Database, Queue, Worker, lỗi).

## 2. Phạm vi

Có trong giai đoạn này:

- **Thiết bị:** 7 loại theo Phần 26 (VPS điều hành, máy quản trị, máy nhân viên, GPU Worker, Media Worker, AI Local Worker, Code Runner). Ghép nối bằng chuỗi dùng một lần trong 30 phút; tạm dừng, thu hồi, xóa.
- **Worker** (`apps/worker`): luôn gọi ra máy chủ, không mở cổng. Báo CPU, RAM, ổ đĩa, GPU (nvidia-smi), nhiệt độ mỗi 15 giây; cảnh báo khi gần đầy hay quá nóng.
- **Phân việc:** loại việc cố định trong chương trình Worker (kiểm tra máy, AI cục bộ qua Ollama, việc thử, chạy mã). Thuê việc 60 giây, chuyển máy khi mất kết nối, hủy, giao lại, giới hạn số việc mỗi máy, theo GPU và RAM trống.
- **Sandbox chạy mã:** Python và Node.js trong container Docker không mạng, chỉ đọc, giới hạn RAM, CPU, tiến trình và thời gian. Chỉ trên máy Code Runner mà chủ máy bật `--allow-code`, chỉ người có quyền `infra.code`.
- **Giám sát hệ thống:** trang `/system` với API, PostgreSQL, Redis, 5 hàng đợi, outbox, tỉ lệ lỗi AI, Workflow, Connector, việc Worker, thiết bị và lỗi gần đây.

Không có trong giai đoạn này:

- Điều khiển máy từ xa, shell tùy ý, remote desktop (Phần 26 cấm từ Internet).
- Khởi động lại dịch vụ, cập nhật Worker tự động, bộ cài đặt (installer).
- Gửi cảnh báo ra ngoài (email, Telegram), AI SRE tự xử lý sự cố (M37 đầy đủ).
- Code Runner đầy đủ với thư viện ngoài, Plugin có mã chạy, AI Development Studio (Giai đoạn 10).

## 3. Danh sách nhiệm vụ

| Sprint | Nội dung | PR |
| --- | --- | --- |
| 13 | Thiết bị, ghép nối, Worker báo tài nguyên, cảnh báo, trang Hạ tầng (M31) | #18 |
| 14 | Giao việc cho Worker: hàng đợi, thuê việc, chuyển máy, Ollama, trang Việc của Worker (M32) | #19 |
| 15 | Sandbox chạy mã, quyền `infra.code`, giám sát hệ thống, trang Giám sát hệ thống (M37) | Sprint 15 |

## 4. Mã nguồn

- **API:** `apps/api/src/devices/` (devices, worker-jobs, system-monitor)
- **Worker:** `apps/worker/src/` (cli, metrics, jobs, sandbox). Hướng dẫn: `docs/WORKER.md`
- **Hợp đồng dữ liệu (Zod):** `packages/contracts/src/` (devices, worker-jobs, monitor)
- **Migration:** `packages/db/migrations/0013` đến `0015`
- **Web:** `/infra`, `/infra/jobs`, `/system`

## 5. Kiểm thử

Lệnh `pnpm build && pnpm typecheck && pnpm test` cho kết quả:

- 186 test của API qua, gồm 5 test e2e mới của Sprint 15.
- 8 test của Worker qua, gồm một test chạy Docker thật.

Những điều đã có test:

- **Thiết bị:** chuỗi ghép nối dùng một lần và hết hạn; khóa sai bị từ chối; thu hồi chặn ngay; cảnh báo không lặp.
- **Phân việc:** việc GPU chỉ cho máy có GPU; giới hạn số việc; hai Worker không nhận trùng; mất kết nối thì chuyển máy; quá giờ báo lỗi; hủy và giao lại.
- **Sandbox:**
  - Máy không phải Code Runner không nhận `code.run`, kể cả khi Worker tự báo làm được hoặc người giao chỉ định máy khác.
  - Thiếu quyền `infra.code` thì không giao được và không Giao lại được.
  - Ô nhập lạ (ngôn ngữ khác, trường `image`) bị từ chối; mã quá dài, thời gian quá 600 giây bị từ chối.
  - Audit chỉ ghi SHA-256 của mã, không ghi mã.
  - Docker thật: đọc được stdin; chạy bằng người dùng 65534; không ra được mạng; không ghi được file hệ thống; đầu ra cắt ở 32 KB; vòng lặp vô hạn bị dừng đúng giờ.
- **Giám sát:** cần đăng nhập và `infra.read`; đủ các mục; Database hay Redis chết thì báo Có lỗi; tỉ lệ lỗi AI cao thì cảnh báo.

Đã thử thật trên máy chủ doanh nghiệp (Windows 10, i5-10400F, 16 GB):

- Sprint 13: ghép nối “Máy của tôi”, báo tài nguyên.
- Sprint 14: việc Kiểm tra máy chạy xong trên máy đó.

Ảnh chụp Sprint 15: `screenshots/sprint15/` trong thư mục dự án.

## 6. Tiêu chí nghiệm thu

| Tiêu chí (Phần 26) | Kết quả |
| --- | --- |
| Worker luôn kết nối ra máy chủ, không mở cổng | Đạt |
| Không shell tùy ý, không remote desktop từ Internet | Đạt. Chỉ có loại việc cố định; mã chỉ chạy trong container cách ly |
| Không lưu mật khẩu quản trị trong bộ cài | Đạt. Chỉ có khóa thiết bị, lưu dạng SHA-256 ở máy chủ |
| Code Runner chỉ trên máy được cấp quyền phát triển | Đạt. Cần loại Code Runner, `--allow-code` của chủ máy và quyền `infra.code` của người giao |
| Theo dõi CPU, RAM, ổ đĩa, GPU, nhiệt độ; cảnh báo | Đạt |
| Phân việc theo tài nguyên, chuyển máy khi lỗi | Đạt |
| Thu hồi thiết bị | Đạt. Việc đang chạy về hàng đợi ngay |
| Giám sát API, Database, Queue, Worker, lỗi (Phần 28) | Đạt. Chưa gửi cảnh báo ra ngoài |
| Dữ liệu tenant tách biệt | Đạt. FORCE RLS trên mọi bảng mới |

## 7. Báo cáo

Giai đoạn 5 hoàn thành phần hạ tầng cốt lõi của Phần 26 và phần giám sát của Phần 28. Chủ hệ thống đã ghép nối máy thật và chạy việc trên đó ngày 2026-11-27. Sandbox chạy mã đã thử với Docker thật trong môi trường kiểm thử; trên máy chủ doanh nghiệp cần Docker Desktop và một thiết bị loại Code Runner.

## 8. Rủi ro

- **Docker là ranh giới an toàn:** container dùng chung nhân hệ điều hành với máy. Lỗ hổng Docker hay nhân có thể cho mã thoát ra. Vì vậy chỉ bật `--allow-code` trên máy riêng cho việc này, không trên máy có dữ liệu quan trọng, và luôn cập nhật Docker Desktop.
- **Mã độc tốn tài nguyên:** đã giới hạn RAM, CPU, tiến trình và thời gian, nhưng nhiều việc cùng lúc vẫn chiếm máy. Giảm “Số việc chạy cùng lúc” của máy Code Runner nếu cần.
- **Người có `infra.code` đọc được mã của người khác:** mọi người có `infra.read` xem được ô nhập của việc. Không viết mật khẩu hay khóa vào mã.
- **Số liệu chung của bản cài:** hàng đợi, Redis và Database là của cả hệ thống, mọi tenant có `infra.read` đều thấy. Phù hợp khi MARIS chạy cho một doanh nghiệp.

## 9. Điều kiện còn thiếu

- Gửi cảnh báo giám sát ra ngoài; AI SRE (M37 đầy đủ).
- Khởi động lại dịch vụ được phép, cập nhật Worker tự động, bộ cài Worker.
- Nối Workflow và Plugin với Worker và sandbox; thư viện ngoài trong sandbox (Giai đoạn 10).
- Mục nhỏ còn lại của Giai đoạn 2: gửi email lời mời, song ngữ vi/en, xoay vòng khóa `VAULT_MASTER_KEY`.

## 10. Phương án rollback

- **Mã nguồn:** quay về commit trước của `main` (`git checkout <commit>`, `pnpm install`, `pnpm build`), rồi chạy lại API, web và Worker.
- **Database:** migration chỉ đi tiến. 0013 và 0014 chỉ thêm schema, bảng và cột; 0015 chỉ thêm một quyền. Mã cũ vẫn chạy trên database mới. Muốn trả về đúng trạng thái trước thì khôi phục bản `pg_dump` chụp trước khi migrate.
- **Tắt nhanh mà không cần rollback:**
  - Chạy Worker không có `--allow-code` để thôi chạy mã, hoặc `--monitor-only` để thôi nhận mọi việc.
  - Đặt “Số việc chạy cùng lúc” của máy là 0, hoặc Tạm dừng, Thu hồi thiết bị.
  - Gỡ quyền `infra.code` khỏi vai trò.

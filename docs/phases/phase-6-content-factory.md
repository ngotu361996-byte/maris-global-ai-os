# Báo cáo nghiệm thu Giai đoạn 6 – Content Factory

Ngày: 2026-11-28 · Sprint 16–20 · PR #21, #23, #24, #26 (đã merge), cùng các bản sửa #22, #25, và PR Sprint 20

Mẫu theo đặc tả Phần 41: Mục tiêu, Phạm vi, Danh sách nhiệm vụ, Mã nguồn, Kiểm thử, Tiêu chí nghiệm thu, Báo cáo, Rủi ro, Điều kiện còn thiếu, Phương án rollback.

## 1. Mục tiêu

Theo đặc tả, Giai đoạn 6 xây kho nội dung, Video AI, Image AI, Content AI và dây chuyền kiểm định. Cụ thể là:

- Lưu nội dung gốc và thành phẩm có nguồn gốc, quyền sử dụng và phiên bản (Phần 11).
- Cho AI viết nội dung chỉ từ thông tin đã xác minh (Phần 13).
- Xử lý ảnh và video trên máy của doanh nghiệp (Phần 12, 13, 26) và làm giọng đọc AI.
- Tự kiểm tra chất lượng và chính sách nền tảng trước khi người duyệt (Phần 12, M30).

## 2. Phạm vi

Có trong giai đoạn này:

- **Kho nội dung gốc và Kho thành phẩm** (M09, M10):
  - Tải tệp lớn theo luồng, băm SHA-256, chặn trùng.
  - Quyền sử dụng của từng nguồn. Không ghi đè bản gốc.
  - Mỗi lần sửa là một phiên bản mới.
  - Quy trình Bản nháp → Chờ duyệt → Đã duyệt → Đã xuất bản.
- **AI viết nội dung** (M13):
  - Chỉ dùng thông tin sản phẩm đã xác minh.
  - Hướng dẫn riêng cho từng nền tảng.
  - Bản ngôn ngữ, thị trường hoặc nền tảng khác.
  - Cảnh báo số liệu và lời quảng cáo không có căn cứ.
  - Chạy qua AI Router, ngân sách và Dừng khẩn cấp.
- **Xử lý ảnh** trên Media Worker (sharp):
  - Các cỡ theo nền tảng, cắt theo phần chính hoặc giữ trọn ảnh.
  - Logo, chỉnh ánh sáng, tăng nét.
  - Bỏ metadata và vị trí.
- **Xử lý video** trên Media Worker (FFmpeg):
  - Cắt đoạn, đổi tỉ lệ khung, giảm nhiễu, tăng nét, logo.
  - Lồng giọng đọc, ảnh bìa.
  - H.264 + AAC, bỏ metadata.
- **Giọng đọc AI:**
  - Giọng OpenAI, sáu giọng nam và nữ, tự luân phiên.
  - Tính vào ngân sách AI.
  - Kết quả là một thành phẩm âm thanh cần duyệt.
- **Dây chuyền kiểm định** (Sprint 20, M30): kiểm tra phiên bản hiện tại của mọi thành phẩm.
  - **Chữ:** độ dài và số hashtag theo nền tảng, chỗ chưa điền (`[giá]`, `{{link}}`, TODO).
  - **Lời quảng cáo rủi ro:**
    - so sánh tuyệt đối (“nhất”, “số 1”) và lời cam kết;
    - chữa bệnh, hứa hẹn kết quả cơ thể, an toàn tuyệt đối (Luật Quảng cáo và chính sách quảng cáo của nền tảng);
    - viết hoa quá nhiều, chuỗi “!!!”, ngôn ngữ không khớp.
  - **Tệp:**
    - đúng loại tệp;
    - cỡ ảnh và video tối thiểu;
    - tỉ lệ khung theo nền tảng;
    - thời lượng tối đa của nền tảng.
  - Cỡ và thời lượng được đọc từ đầu tệp khi nhận.
  - **Lỗi** chặn Gửi duyệt và Duyệt. **Cảnh báo** hiện cho người duyệt. Audit ghi kết quả kiểm định khi gửi và khi duyệt.

Không có trong giai đoạn này:

- AI tạo ảnh hay video, tách nền, thay nền, phụ đề tự động, nhạc nền, ghép nhiều đoạn video.
- AI đọc PDF hay video làm tài liệu.
- Kiểm định bằng AI, nhận dạng chữ hay logo trong ảnh, kiểm tra bản quyền nhạc.
- Xuất bản lên nền tảng (Giai đoạn 7), lưu trữ trên S3/MinIO.

## 3. Danh sách nhiệm vụ

| Sprint | Nội dung | PR |
| --- | --- | --- |
| 16 | Kho nội dung gốc, Kho thành phẩm, phiên bản, quyền sử dụng, duyệt (M09, M10) | #21, #22 |
| 17 | AI viết nội dung, bản ngôn ngữ và nền tảng khác (M13) | #23 |
| 18 | Xử lý ảnh trên Media Worker | #24, #25 |
| 19 | Xử lý video bằng FFmpeg, giọng đọc AI | #26 |
| 20 | Dây chuyền kiểm định chất lượng và chính sách nền tảng (M30) | Sprint 20 |

## 4. Mã nguồn

- **API:** `apps/api/src/content/`, gồm:
  - `content.service.ts`
  - `content-ai.service.ts`
  - `content-media.service.ts`
  - `content-voice.service.ts`
  - `content-qa.ts`
- **API:** `apps/api/src/files/media-info.ts`
- **Worker:** `apps/worker/src/` (image, video). Hướng dẫn: `docs/WORKER.md`
- **Hợp đồng dữ liệu (Zod):** `packages/contracts/src/content.ts`
- **Migration:** `packages/db/migrations/0016` đến `0020`
- **Web:**
  - `/content` (Kho nội dung gốc, Xử lý ảnh, Xử lý video)
  - `/content/items` (Kho thành phẩm, AI viết, Giọng đọc AI, Kiểm định tự động)

## 5. Kiểm thử

Lệnh `pnpm build && pnpm typecheck && pnpm test` cho kết quả:

- 218 test của API qua, gồm 4 test e2e và 7 test đơn vị mới của Sprint 20.
- 10 test của Worker qua, gồm các test FFmpeg và sharp thật. Test sandbox Docker bỏ qua khi máy kiểm thử không có Docker.

Những điều đã có test:

- **Kho:**
  - Tệp trùng bị từ chối.
  - Trigger chặn sửa bản gốc; phiên bản chỉ được thêm.
  - Không duyệt được khi nguồn chưa rõ quyền.
  - Tải về có `CSP: sandbox`.
- **AI viết:**
  - Thông tin chưa xác minh bị từ chối.
  - Con số và lời quảng cáo lạ bị cảnh báo và chặn duyệt.
  - Hủy giữa chừng; bản ngôn ngữ khác liên kết với bản gốc.
- **Ảnh và video:**
  - Worker chỉ tải được tệp của việc mình đang chạy.
  - Máy chủ nhận dạng lại tệp kết quả.
  - Gửi lại cùng cỡ không tạo trùng.
  - Video xoay của điện thoại ra đúng chiều.
  - Hủy thì dừng FFmpeg.
- **Giọng đọc:**
  - Luân phiên giọng.
  - Ghi chi phí gắn với mục văn bản.
  - Chặn khi Dừng khẩn cấp hay hết ngân sách.
- **Kiểm định:**
  - Lời quảng cáo rủi ro là cảnh báo; người duyệt vẫn duyệt được, và audit ghi `qa`.
  - Chỗ chưa điền chặn Gửi duyệt (409 `CONTENT_QA_FAILED`); phiên bản sửa thì qua.
  - Đổi nền tảng thì giới hạn hashtag đổi theo.
  - Đọc đúng cỡ PNG, JPEG, GIF, WebP và cỡ, thời lượng MP4 (kể cả video xoay).
  - Video có chỉ mục ở cuối tệp thì báo “chưa đọc được”, không chặn.
  - Danh sách trả về trạng thái kiểm định.

Đã thử thật trên máy chủ doanh nghiệp (Windows 10, i5-10400F, 16 GB): Sprint 19, Worker nhận việc `media.video`.

Ảnh chụp Sprint 20: `screenshots/sprint20/` trong thư mục dự án.

## 6. Tiêu chí nghiệm thu

| Tiêu chí | Kết quả |
| --- | --- |
| Lưu nguồn, quyền sử dụng, chủ sở hữu, hạn quyền (Phần 11) | Đạt |
| Không ghi đè bản gốc, mọi thay đổi là phiên bản mới | Đạt. Trigger trong database và bảng chỉ thêm |
| AI chỉ dùng dữ liệu đã xác minh, không tự bịa (Phần 13) | Đạt. Con số không có căn cứ bị cảnh báo và chặn duyệt |
| Mọi nội dung AI cần người duyệt | Đạt |
| Chuẩn hóa ảnh và video theo nền tảng, logo, giọng đọc (Phần 12) | Đạt. Chạy trên máy doanh nghiệp qua Media Worker |
| Tự động kiểm tra chất lượng trước khi duyệt (Phần 12) | Đạt. Lỗi chặn gửi duyệt và duyệt |
| Bảo vệ chính sách nền tảng (M30) | Đạt một phần. Quy tắc cố định về giới hạn nền tảng và lời quảng cáo; chưa có kiểm định bằng AI |
| Chi phí AI có ngân sách và ghi lại (Phần 21) | Đạt |
| Dữ liệu tenant tách biệt | Đạt. FORCE RLS trên mọi bảng mới |

## 7. Báo cáo

Giai đoạn 6 hoàn thành dây chuyền làm nội dung: nhập nội dung gốc, AI viết, xử lý ảnh và video trên máy của doanh nghiệp, giọng đọc, kiểm định tự động, rồi người duyệt. Mọi thành phẩm đều có nguồn gốc và phiên bản. Mọi bước dùng AI đều qua ngân sách và Dừng khẩn cấp. Chủ hệ thống đã cập nhật lên Sprint 19 và Worker nhận việc video ngày 2026-11-27.

## 8. Rủi ro

- **Kiểm định dựa trên quy tắc:**
  - Từ khóa có thể báo nhầm, ví dụ “nhất” trong một câu bình thường.
  - Cũng có thể bỏ sót lời quảng cáo viết khác đi.
  - Vì vậy rủi ro chỉ là cảnh báo, và người duyệt vẫn phải đọc.
  - Giới hạn của nền tảng thay đổi theo thời gian; bảng `PLATFORM_LIMITS` cần xem lại định kỳ.
- **Cỡ và thời lượng video:**
  - Chỉ đọc được khi chỉ mục (moov) ở đầu tệp, như video MARIS tự làm.
  - Video tải lên từ nơi khác có thể báo “chưa đọc được”.
- **Lưu trữ trên đĩa máy chủ:** cần sao lưu `apps\api\data\uploads` cùng `.env`.
- **FFmpeg và sharp chạy trên máy Worker:** tệp lạ có thể làm thư viện lỗi. Nên dùng máy riêng và cập nhật FFmpeg.
- **Giá giọng đọc** là ước tính theo số ký tự.

## 9. Điều kiện còn thiếu

- Kiểm định bằng AI (đọc chữ trên ảnh, nghe lời trong video), kiểm tra bản quyền nhạc.
- Đọc cỡ và thời lượng của video có chỉ mục ở cuối (cần ffprobe trên máy chủ hoặc nhờ Worker).
- AI tạo ảnh và video, phụ đề tự động, nhạc nền.
- Xuất bản lên Facebook, Instagram và các nền tảng khác (Giai đoạn 7 – Meta Platform).
- Mục nhỏ còn lại của Giai đoạn 2: gửi email lời mời, song ngữ vi/en, xoay vòng khóa `VAULT_MASTER_KEY`.

## 10. Phương án rollback

- **Mã nguồn:** quay về commit trước của `main` (`git checkout <commit>`, `pnpm install`, `pnpm build`), rồi chạy lại API, web và Worker.
- **Database:** migration chỉ đi tiến.
  - 0016 đến 0019 thêm schema, bảng, cột, quyền và chỉ mục.
  - 0020 chỉ thêm ba cột có thể để trống.
  - Mã cũ vẫn chạy trên database mới.
  - Muốn trả về đúng trạng thái trước thì khôi phục bản `pg_dump` chụp trước khi migrate.
- **Tắt nhanh mà không cần rollback:**
  - Tắt Media Worker hoặc chạy `--monitor-only` để thôi xử lý ảnh và video.
  - Tắt AI Provider hoặc bấm Dừng khẩn cấp để thôi AI viết và giọng đọc.
  - Gỡ quyền `content.generate` khỏi vai trò.

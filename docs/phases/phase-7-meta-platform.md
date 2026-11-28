# Báo cáo nghiệm thu Giai đoạn 7 – Meta Platform

Ngày: 2026-11-28 · Sprint 21–25 · PR #28, #29, #30, #31 (đã merge) và PR Sprint 25

Mẫu theo đặc tả Phần 41: Mục tiêu, Phạm vi, Danh sách nhiệm vụ, Mã nguồn, Kiểm thử, Tiêu chí nghiệm thu, Báo cáo, Rủi ro, Điều kiện còn thiếu, Phương án rollback.

## 1. Mục tiêu

Theo đặc tả, Giai đoạn 7 xây Meta Connector, Webhook, xuất bản, CRM, quảng cáo và API Governor. Cụ thể là:

- Kết nối Facebook bằng OAuth chính thức của Meta App doanh nghiệp, giữ token an toàn (Phần 14, 26).
- Điều phối mọi lượt gọi Meta trong hạn mức nội bộ và hạn mức Meta báo (Phần 15).
- Đăng nội dung đã duyệt lên Page và Instagram theo lịch (Phần 14, M16).
- Nhận và trả lời bình luận, tin nhắn; đưa khách hàng và lead vào CRM (Phần 14, 20, M24, M25).
- Xem quảng cáo, phân tích chi tiêu, quản lý ngân sách có duyệt (Phần 14, 19, M23).

## 2. Phạm vi

Có trong giai đoạn này:

- **Kết nối Meta** (Sprint 21, M17):
  - Mỗi doanh nghiệp dùng Meta App của mình; App Secret nằm trong Secret Vault.
  - OAuth với `state` dùng một lần, token dài hạn, `appsecret_proof` mỗi lượt gọi.
  - Token mã hóa AES-256-GCM, không bao giờ trả về trình duyệt.
  - Đồng bộ Page, Instagram, tài khoản quảng cáo; bật tối đa 20 Page và 10 tài khoản quảng cáo.
  - Kiểm tra token và quyền; chức năng chỉ “sẵn sàng” khi Meta đã cấp quyền.
- **API Governor** (Sprint 21, Phần 15):
  - Ngân sách 24 giờ theo 8 nhóm, tổng 3.000 lượt, chỉnh được, mượn Dự phòng.
  - Ngưỡng 75% hoãn việc nền, 85% chỉ việc thiết yếu, 90% tạm dừng nhóm.
  - Đọc header hạn mức của Meta; thiếu số liệu ghi UNKNOWN hoặc STALE.
  - Meta báo giới hạn thì dừng đúng thời gian Meta yêu cầu; ngắt mạch khi lỗi liên tục; cache và gộp lượt đọc trùng.
  - Mọi lượt gọi và lượt bị từ chối được ghi, không có token.
- **Xuất bản** (Sprint 22, M16):
  - Chỉ thành phẩm đã duyệt, kiểm định không lỗi.
  - Bài chữ, ảnh, video, Reels lên Page; ảnh, Reels lên Instagram.
  - Lịch đăng, 3 bài mỗi Page mỗi ngày, 60 bài mỗi ngày; mỗi phiên bản một bài mỗi nơi.
  - Thử lại lỗi tạm thời, dừng sau 3 lỗi, kết quả không rõ để người xem, không đăng trùng.
- **Hộp thư khách hàng** (Sprint 23, M24):
  - Webhook có kiểm chữ ký; đọc dự phòng khi không có địa chỉ công khai.
  - Messenger, tin nhắn Instagram, bình luận Page và Instagram.
  - Trả lời trong 24 giờ, tối đa 400 lượt mỗi ngày, không gửi trùng.
  - AI gợi ý trả lời, không tự gửi.
- **CRM và Lead Ads** (Sprint 24, M25):
  - Khách hàng từ mọi kênh, giai đoạn bán hàng, người phụ trách, lịch sử chỉ thêm.
  - Một số điện thoại hoặc email một khách hàng.
  - Lead từ webhook `leadgen` và đọc dự phòng, ghép vào khách đã có.
  - Thông tin khách không vào nhật ký kiểm toán.
- **Trung tâm quảng cáo** (Sprint 25, M23):
  - Đọc chiến dịch, nhóm quảng cáo, quảng cáo và số liệu theo ngày, mỗi tài khoản khoảng 30 phút theo vòng quay.
  - Chi tiêu, CTR, CPC, CPM, CPA, ROAS; so sánh chiến dịch; biểu đồ theo ngày.
  - Số mua và ROAS ghi rõ là Meta báo cáo, không phải doanh thu thực nhận.
  - Cảnh báo bất thường và gợi ý tối ưu; MARIS chỉ báo, không tự sửa.
  - Tạm dừng, bật lại, đổi ngân sách hằng ngày. Vượt giới hạn đã duyệt thì chờ chủ hoặc quản trị duyệt.
  - Không bật lại quảng cáo bị Meta từ chối.

Không có trong giai đoạn này:

- Tạo chiến dịch, nhóm quảng cáo, quảng cáo mới; sửa đối tượng và nội dung quảng cáo.
- Phân tích Page và bài đăng (lượt tiếp cận, tương tác theo bài).
- Ẩn hoặc xóa bình luận, gửi tệp đính kèm trong tin nhắn, tự trả lời không cần người.
- Nhập hay xuất CRM bằng Excel, gộp hai khách trùng có sẵn, tự giao lead.
- Google Ads, TikTok Ads, YouTube, Shopify, POSCake (Giai đoạn 8); đối chiếu doanh thu thật (Giai đoạn 9).

## 3. Danh sách nhiệm vụ

| Sprint | Nội dung | PR |
| --- | --- | --- |
| 21 | Kết nối Meta, Trung tâm Meta, API Governor (M17) | #28 |
| 22 | Xuất bản lên Page và Instagram, lịch đăng (M16) | #29 |
| 23 | Webhook, hộp thư bình luận và tin nhắn, AI gợi ý (M24) | #30 |
| 24 | CRM, Lead Ads (M25) | #31 |
| 25 | Trung tâm quảng cáo, phân tích chi tiêu, duyệt ngân sách (M23) | Sprint 25 |

## 4. Mã nguồn

- **API, module Meta** `apps/api/src/meta/`:
  - `meta.service.ts`, `meta.controller.ts` (kết nối, tài sản)
  - `meta-graph.service.ts`, `governor.ts` (API Governor)
  - `meta-publish.service.ts` (xuất bản)
  - `meta-inbox.service.ts`, `meta-inbox.controller.ts`, `inbox-events.ts` (webhook, hộp thư)
  - `meta-leads.service.ts` (Lead Ads)
  - `meta-ads.service.ts`, `meta-ads.controller.ts`, `ads-analysis.ts` (quảng cáo)
- **API, module CRM** `apps/api/src/crm/`
- **Hợp đồng dữ liệu (Zod):** `packages/contracts/src/meta.ts`, `crm.ts`, `ads.ts`
- **Migration:** `packages/db/migrations/0021` đến `0025`
- **Web:** `/meta`, `/meta/callback`, `/meta/posts`, `/inbox`, `/crm`, `/ads`
- **Hướng dẫn:** `docs/META.md` (tạo Meta App, quyền, webhook, Lead Ads, quảng cáo)

## 5. Kiểm thử

Lệnh `pnpm build && pnpm typecheck && pnpm test` cho kết quả:

- 280 test của API qua (38 bộ), gồm 7 test e2e và 6 test đơn vị mới của Sprint 25.
- 10 test của Worker, 5 của SDK, 2 của DB qua.

Mọi test e2e của Meta chạy với một máy chủ Graph API giả trên máy, không gọi Meta thật. Những điều đã có test:

- **Kết nối và Governor:**
  - App Secret chỉ nằm trong Secret Vault; token được niêm phong, không trả về trình duyệt.
  - Một tài khoản Facebook mỗi doanh nghiệp, giới hạn 20 Page và 10 tài khoản quảng cáo.
  - Cache và gộp lượt đọc trùng; Meta báo giới hạn thì dừng đúng thời gian và ghi lượt bị từ chối.
  - Token Meta thu hồi thì đánh dấu; ngắt kết nối xóa mọi token.
  - Ngưỡng hạn mức, đọc header, UNKNOWN/STALE có test đơn vị (`governor.spec.ts`).
- **Xuất bản:**
  - Thành phẩm chưa duyệt hoặc kiểm định lỗi bị chặn.
  - Hạn mức 3 bài mỗi Page, 60 bài mỗi ngày; thử lại, dừng sau 3 lỗi; hủy rồi xếp lịch lại.
- **Hộp thư:**
  - Chữ ký webhook sai bị từ chối; mỗi sự kiện một lần.
  - Ngoài 24 giờ không trả lời được; 400 lượt mỗi ngày; một lần bấm một lần gửi.
- **CRM và Lead Ads:**
  - Số `+84 912…` và `0912…` là một khách; lead mới ghép vào khách đã có.
  - Thông tin khách không có trong audit.
- **Quảng cáo:**
  - Lần đầu đọc 30 ngày, sau đó 3 ngày; theo trang; mọi lượt đọc nhóm `ads_insights`.
  - Chiến dịch mới làm đọc lại cấu trúc; chiến dịch không còn trên Meta được đánh dấu.
  - Tổng chi tiêu, CTR, CPC, CPM, CPA, ROAS đúng; một lượt mua Meta báo hai tên chỉ tính một lần.
  - Ngày theo múi giờ tài khoản; VND nguyên đồng, USD theo cent.
  - Tạm dừng gửi ngay, nhóm `ads_manage`; bật lại khi chưa đặt giới hạn phải duyệt; quản lý không duyệt được.
  - Tăng ngân sách trong giới hạn gửi ngay, vượt giới hạn chờ duyệt; rút lại, từ chối; một thay đổi đang mở mỗi loại.
  - Quảng cáo bị từ chối không bật lại được; Meta từ chối thay đổi thì ghi lỗi, không đổi số trong MARIS.
  - Cảnh báo: tài khoản không hoạt động, quảng cáo bị từ chối, chi tiêu tăng vọt, CPA tăng, chưa có kết quả, CTR thấp, không hiển thị.
  - RLS: tenant khác không thấy dữ liệu quảng cáo.

Đã thử thật trên máy chủ doanh nghiệp (Windows 10) với Meta App thật:

- 2026-11-28: kết nối 10 Page, đăng bài thật đầu tiên (Sprint 22).
- Nhận tin Messenger và trả lời (Sprint 23); lưu khách Messenger vào CRM, quyền Lead Ads đã cấp (Sprint 24).
- Sprint 25: chờ cập nhật máy và bấm “Đọc Meta ngay”.

Ảnh chụp: `screenshots/sprint21/` đến `screenshots/sprint24/` trong thư mục dự án.

## 6. Tiêu chí nghiệm thu

| Tiêu chí | Kết quả |
| --- | --- |
| Tích hợp qua API chính thức và OAuth, không cookie hay trình duyệt giả lập (Phần 14) | Đạt |
| Kiểm tra quyền và trạng thái token | Đạt |
| Ngân sách API theo nhóm, ngưỡng điều phối, tôn trọng yêu cầu dừng của Meta (Phần 15) | Đạt |
| Không giả lập phần trăm hạn mức; thiếu số liệu ghi UNKNOWN/STALE | Đạt |
| Webhook trước, đọc dự phòng khi cần (Phần 15) | Đạt. Máy chưa có địa chỉ công khai dùng đọc dự phòng |
| Xuất bản chỉ nội dung đã duyệt, theo lịch và hạn mức | Đạt |
| Hộp thư, trả lời trong quy định 24 giờ, 400 lượt mỗi ngày | Đạt |
| CRM một khách một hồ sơ, lịch sử không sửa được (Phần 20) | Đạt |
| Lead Ads vào CRM | Đạt. Chưa có biểu mẫu thật để thử vì Page chưa chạy quảng cáo lead |
| Phân tích CTR, CPC, CPM, CPA, ROAS, chi phí, so sánh chiến dịch (Phần 19) | Đạt. Số liệu theo chiến dịch |
| Phân biệt chuyển đổi do nền tảng báo với doanh thu thực tế (Phần 19) | Đạt. Ghi rõ trên giao diện và trong dữ liệu |
| Không tự tăng ngân sách ngoài giới hạn được duyệt (Phần 19) | Đạt. Vượt giới hạn phải có `ads.approve` |
| Không tự gửi lại quảng cáo bị từ chối (Phần 19) | Đạt |
| Cảnh báo bất thường, đề xuất tối ưu | Đạt một phần. Theo quy tắc cố định, chưa dùng AI |
| Tạo bản nháp chiến dịch, AI viết và đề xuất Creative cho quảng cáo | Chưa. AI viết nội dung quảng cáo có ở Giai đoạn 6; tạo chiến dịch để sau |
| Dữ liệu tenant tách biệt | Đạt. FORCE RLS trên mọi bảng mới |

## 7. Báo cáo

Giai đoạn 7 nối MARIS với Facebook và Instagram của doanh nghiệp qua Meta App riêng: kết nối an toàn, đăng nội dung đã duyệt, nhận và trả lời khách, gom khách và lead vào CRM, xem và quản lý quảng cáo. Mọi lượt gọi Meta đi qua API Governor, nên MARIS dừng đúng lúc Meta yêu cầu và không vượt hạn mức nội bộ. Mọi thay đổi gửi Meta (bài đăng, trả lời, ngân sách) đều ghi audit; tăng ngân sách vượt giới hạn cần người duyệt. Chủ hệ thống đã chạy Sprint 21–24 trên máy với Meta App thật ngày 2026-11-28.

## 8. Rủi ro

- **Meta App ở chế độ phát triển:** chỉ người có vai trò trong App dùng được. Cho người ngoài dùng cần App Review và xác minh doanh nghiệp.
- **Không có địa chỉ công khai:** webhook không tới được máy; tin nhắn và lead đến chậm tới 15 phút (đọc dự phòng).
- **Số liệu quảng cáo:** Meta sửa số các ngày gần đây và theo cửa sổ phân bổ; MARIS đọc lại 3 ngày gần nhất nên số cũ hơn có thể lệch nhẹ với Trình quản lý quảng cáo. Reach cộng theo ngày đếm một người nhiều lần.
- **Hạn mức:** 10 tài khoản quảng cáo đọc mỗi 30 phút dùng gần hết phần “Phân tích quảng cáo” (480 lượt mỗi ngày); Governor mượn Dự phòng hoặc hoãn lượt đọc nền. Tăng `META_ADS_POLL_MIN` nếu cần.
- **Cảnh báo theo quy tắc:** có thể báo nhầm với chiến dịch mới hoặc ngân sách thay đổi; người vẫn phải xem.
- **Token dài hạn khoảng 60 ngày:** hết hạn thì cần Kết nối lại; Trung tâm Meta báo khi token mất hiệu lực.

## 9. Điều kiện còn thiếu

- Tạo bản nháp chiến dịch, nhóm quảng cáo, quảng cáo; AI đề xuất Creative và tối ưu (cần quy trình duyệt riêng).
- Phân tích Page và bài đăng; số liệu quảng cáo theo từng quảng cáo, độ tuổi, vị trí.
- Địa chỉ HTTPS công khai cho webhook (VPS hoặc đường hầm) để nhận tin và lead ngay.
- App Review của Meta khi có người dùng ngoài doanh nghiệp.
- Mục nhỏ còn lại của Giai đoạn 2: gửi email lời mời, song ngữ vi/en, xoay vòng khóa `VAULT_MASTER_KEY`.

## 10. Phương án rollback

- **Mã nguồn:** quay về commit trước của `main` (`git checkout <commit>`, `pnpm install`, `pnpm build`), rồi chạy lại API và web.
- **Database:** migration chỉ đi tiến.
  - 0021 đến 0025 thêm schema, bảng, cột, quyền, chỉ mục và chính sách RLS.
  - Mã cũ vẫn chạy trên database mới.
  - Muốn trả về đúng trạng thái trước thì khôi phục bản `pg_dump` chụp trước khi migrate.
- **Tắt nhanh mà không cần rollback:**
  - Ngắt kết nối Facebook ở Trung tâm Meta: MARIS báo Meta thu hồi quyền và xóa mọi token.
  - Tắt Page hoặc tài khoản quảng cáo trong Trung tâm Meta.
  - Đặt `META_PUBLISHER_ENABLED=false`, `META_INBOX_POLL_MIN=0`, `META_LEADS_POLL_MIN=0`, `META_ADS_POLL_MIN=0` để thôi chạy nền.
  - Gỡ quyền `meta.publish`, `inbox.reply`, `ads.manage` khỏi vai trò.

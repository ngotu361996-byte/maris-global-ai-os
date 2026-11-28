# Kết nối Facebook và Instagram (Trung tâm Meta)

MARIS kết nối với Meta bằng đăng nhập chính thức (OAuth) qua một Meta App của chính doanh nghiệp. MARIS không dùng cookie, mật khẩu Facebook hay trình duyệt giả lập.

## 1. Tạo Meta App

1. Mở https://developers.facebook.com, đăng nhập bằng tài khoản Facebook quản trị các Page.
2. Chọn **Ứng dụng của tôi → Tạo ứng dụng**, chọn loại **Doanh nghiệp (Business)**, gắn với Business Portfolio của doanh nghiệp.
3. Trong ứng dụng, thêm sản phẩm **Đăng nhập Facebook dành cho doanh nghiệp (Facebook Login for Business)**.
4. Vào **Cài đặt** của sản phẩm đó và thêm vào **URI chuyển hướng OAuth hợp lệ** đúng địa chỉ mà Trung tâm Meta hiển thị. Khi chạy trên máy, địa chỉ là `http://localhost:3000/meta/callback`.
5. Vào **Trường hợp sử dụng (Use cases)** và thêm **Quản lý mọi thứ trên Trang của bạn** và **Quản lý tin nhắn và nội dung trên Instagram**. Ở mỗi mục, bấm **Tùy chỉnh** và thêm các quyền: `pages_manage_posts`, `pages_manage_engagement`, `pages_read_user_content`, `read_insights`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_messages`. Thiếu bước này, khi kết nối Facebook sẽ báo **Invalid Scopes**.
6. Vào **Cài đặt ứng dụng → Thông tin cơ bản**. Ghi lại **ID ứng dụng (App ID)**, rồi bấm **Hiển thị** ở **Khóa bí mật của ứng dụng (App Secret)**.

## 2. Nhập vào MARIS

1. Vào **Secret Vault** và thêm một secret tên `meta.app_secret`, giá trị là App Secret. Không dán App Secret vào chat hay vào ô nào khác.
2. Vào **Trung tâm Meta**, nhập App ID rồi bấm **Lưu Meta App**.
3. Bấm **Kết nối Facebook**. Ở trang của Meta, chọn các Page, tài khoản Instagram và tài khoản quảng cáo muốn giao cho MARIS, rồi cho phép.

Nếu Facebook báo **Error validating client secret**, App Secret trong Secret Vault không khớp với App ID: có thể đã dán nhầm Client Token, dính dấu cách, hoặc secret đã bị đặt lại bên Meta. Sao chép lại App Secret (32 ký tự), cập nhật secret `meta.app_secret` rồi kết nối lại.

## 3. Chế độ phát triển và App Review

- Khi ứng dụng ở **chế độ phát triển**, chỉ người có vai trò trong ứng dụng (quản trị viên, nhà phát triển, người thử) đăng nhập được. Họ được cấp mọi quyền mà không cần Meta duyệt. Chế độ này đủ để một doanh nghiệp dùng cho các Page của chính mình.
- Muốn người ngoài ứng dụng đăng nhập, hoặc khi Meta yêu cầu, ứng dụng cần **App Review**, **Business Verification** và **Advanced Access** cho từng quyền. Trung tâm Meta chỉ coi một chức năng là sẵn sàng khi quyền đó thật sự được cấp.

## 4. Đăng bài lên Page và Instagram

1. Vào **Kho thành phẩm**, mở một thành phẩm **đã duyệt** (kiểm định không lỗi).
2. Ở khung **Đăng lên Facebook và Instagram**, chọn Page hoặc tài khoản Instagram đang bật, viết chú thích (ảnh, video) hoặc đường dẫn (bài chữ), rồi chọn **Đăng ngay** hoặc **Hẹn giờ** (khung gợi ý 09:00, 12:00, 20:00).
3. Theo dõi ở **Trung tâm Meta → Lịch đăng bài**. MARIS kiểm tra hàng đợi mỗi 30 giây.

Cách đăng theo loại thành phẩm:

| Thành phẩm | Lên Page | Lên Instagram |
| --- | --- | --- |
| Chữ | Bài viết (kèm đường dẫn nếu có) | Không hỗ trợ |
| Ảnh | Ảnh (tối đa 10 MB) | Ảnh (MARIS đưa ảnh lên Page ở chế độ ẩn để Instagram lấy) |
| Video | Reels 3–90 giây, hoặc Video thường | Reels 3–900 giây |

Hạn mức: tối đa 3 bài mỗi ngày cho mỗi Page hoặc tài khoản, 60 bài mỗi ngày cho cả công ty, tính theo giờ Việt Nam. Mỗi phiên bản chỉ đăng một lần lên mỗi nơi.

Khi gặp lỗi:

- Meta báo lỗi tạm thời: MARIS tự thử lại tối đa 3 lần, cách 5, 10 phút.
- Hết hạn mức API hoặc Meta yêu cầu tạm dừng: bài lùi lại 15 phút, không tính là một lần thử. Quá 24 giờ so với lịch thì dừng.
- Mất kết nối giữa lúc đăng: MARIS **không tự đăng lại** vì bài có thể đã lên. Bài chuyển sang **Lỗi, chờ xử lý** với ghi chú “không rõ bài đã lên chưa”. Hãy mở Page kiểm tra, rồi bấm **Thử lại** nếu chưa có, hoặc **Hủy**.

Bài lỗi nằm ở Lịch đăng bài (lọc **Lỗi, chờ xử lý**) cho đến khi có người xử lý.

## 5. Hạn mức

Gói BUSINESS cho 1 tài khoản Facebook, tối đa 20 Page và 10 tài khoản quảng cáo, khoảng 3.000 lượt gọi API mỗi ngày, chia theo nhóm (đặc tả Phần 15). Đây là giới hạn nội bộ của MARIS, không phải hạn mức hay cam kết của Meta. Khi Meta báo giới hạn, MARIS dừng gọi đúng thời gian Meta yêu cầu.

## 6. Ngắt kết nối

Bấm **Ngắt kết nối** ở Trung tâm Meta. MARIS báo Meta thu hồi quyền và xóa mọi token đã lưu. Có thể gỡ thêm ứng dụng trong **Cài đặt Facebook → Doanh nghiệp tích hợp**.

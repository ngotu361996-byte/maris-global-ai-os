# Kết nối Facebook và Instagram (Trung tâm Meta)

MARIS kết nối với Meta bằng đăng nhập chính thức (OAuth) qua một Meta App của chính doanh nghiệp. MARIS không dùng cookie, mật khẩu Facebook hay trình duyệt giả lập.

## 1. Tạo Meta App

1. Mở https://developers.facebook.com, đăng nhập bằng tài khoản Facebook quản trị các Page.
2. Chọn **Ứng dụng của tôi → Tạo ứng dụng**, chọn loại **Doanh nghiệp (Business)**, gắn với Business Portfolio của doanh nghiệp.
3. Trong ứng dụng, thêm sản phẩm **Đăng nhập Facebook dành cho doanh nghiệp (Facebook Login for Business)**.
4. Vào **Cài đặt** của sản phẩm đó và thêm vào **URI chuyển hướng OAuth hợp lệ** đúng địa chỉ mà Trung tâm Meta hiển thị. Khi chạy trên máy, địa chỉ là `http://localhost:3000/meta/callback`.
5. Vào **Cài đặt ứng dụng → Thông tin cơ bản**. Ghi lại **ID ứng dụng (App ID)**, rồi bấm **Hiển thị** ở **Khóa bí mật của ứng dụng (App Secret)**.

## 2. Nhập vào MARIS

1. Vào **Secret Vault** và thêm một secret tên `meta.app_secret`, giá trị là App Secret. Không dán App Secret vào chat hay vào ô nào khác.
2. Vào **Trung tâm Meta**, nhập App ID rồi bấm **Lưu Meta App**.
3. Bấm **Kết nối Facebook**. Ở trang của Meta, chọn các Page, tài khoản Instagram và tài khoản quảng cáo muốn giao cho MARIS, rồi cho phép.

## 3. Chế độ phát triển và App Review

- Khi ứng dụng ở **chế độ phát triển**, chỉ người có vai trò trong ứng dụng (quản trị viên, nhà phát triển, người thử) đăng nhập được. Họ được cấp mọi quyền mà không cần Meta duyệt. Chế độ này đủ để một doanh nghiệp dùng cho các Page của chính mình.
- Muốn người ngoài ứng dụng đăng nhập, hoặc khi Meta yêu cầu, ứng dụng cần **App Review**, **Business Verification** và **Advanced Access** cho từng quyền. Trung tâm Meta chỉ coi một chức năng là sẵn sàng khi quyền đó thật sự được cấp.

## 4. Hạn mức

Gói BUSINESS cho 1 tài khoản Facebook, tối đa 20 Page và 10 tài khoản quảng cáo, khoảng 3.000 lượt gọi API mỗi ngày, chia theo nhóm (đặc tả Phần 15). Đây là giới hạn nội bộ của MARIS, không phải hạn mức hay cam kết của Meta. Khi Meta báo giới hạn, MARIS dừng gọi đúng thời gian Meta yêu cầu.

## 5. Ngắt kết nối

Bấm **Ngắt kết nối** ở Trung tâm Meta. MARIS báo Meta thu hồi quyền và xóa mọi token đã lưu. Có thể gỡ thêm ứng dụng trong **Cài đặt Facebook → Doanh nghiệp tích hợp**.

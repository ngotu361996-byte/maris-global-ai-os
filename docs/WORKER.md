# MARIS Worker: ghép nối một máy với MARIS

Worker là chương trình nhỏ chạy trên VPS, máy quản trị hay máy GPU. Nó tự kết nối ra máy chủ MARIS và báo CPU, RAM, ổ đĩa, GPU mỗi 15 giây.

- Worker chỉ gọi ra ngoài. Nó không mở cổng nào trên máy và không chạy lệnh nào do máy chủ gửi.
- Bộ cài không chứa tài khoản quản trị. Mỗi máy có một khóa thiết bị riêng. MARIS chỉ giữ bản băm của khóa.
- GPU NVIDIA được đọc qua `nvidia-smi` (có sẵn khi cài driver NVIDIA). Máy không có GPU NVIDIA vẫn báo CPU, RAM và ổ đĩa.

## Ghép nối

1. Trên MARIS, vào **Hạ tầng → Thêm thiết bị**, đặt tên, chọn loại, bấm **Tạo và lấy chuỗi ghép nối**. Chuỗi hiện một lần, dùng được một lần, hết hạn sau 30 phút.
2. Trên máy cần ghép nối (đã có Node.js 22 và thư mục mã MARIS đã `pnpm build`), mở terminal ở thư mục MARIS và chạy:

```
pnpm worker pair "maris1.…" --server https://maris.cong-ty.vn
```

3. Chạy Worker:

```
pnpm worker run
```

Trang Hạ tầng hiện máy là **Trực tuyến** trong vòng 15 giây. Bấm Ctrl+C để dừng Worker.

`pnpm worker status` cho biết máy đã ghép nối với đâu. Khóa thiết bị nằm ở `~/.maris-worker/config.json` (Windows: `C:\Users\<tên>\.maris-worker\config.json`). Không gửi tệp này cho ai.

## Địa chỉ máy chủ

- Máy chủ trên Internet phải dùng `https://`. Worker từ chối `http://` để khóa không bị lộ trên đường truyền.
- `http://` chỉ được dùng cho chính máy đó (`localhost`) hoặc mạng nội bộ (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`).

## Thu hồi và chuyển máy

- **Thu hồi khóa:** khóa hết hiệu lực ngay. Worker trên máy đó tự dừng ở lần báo kế tiếp. Thiết bị đã thu hồi không ghép nối lại được; tạo thiết bị mới.
- **Tạo chuỗi ghép nối mới:** dùng khi chuyển Worker sang máy khác. Khi Worker dùng chuỗi mới, khóa cũ hết hiệu lực.
- **Tạm dừng:** máy vẫn báo cáo nhưng sẽ không nhận việc (phân việc có ở Sprint 14).

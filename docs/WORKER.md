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

## Nhận việc

`pnpm worker run` vừa báo cáo vừa nhận việc. Muốn máy chỉ báo cáo, chạy `pnpm worker run --monitor-only`, hoặc đặt **Số việc chạy cùng lúc** là 0 trên trang Hạ tầng.

Worker chỉ làm các loại việc có sẵn trong chương trình, không chạy lệnh hay mã do máy chủ gửi:

| Loại việc | Làm gì |
| --- | --- |
| Kiểm tra máy | Báo cáo hệ điều hành, CPU, RAM, ổ đĩa, GPU, Node.js, Ollama và độ trễ tới MARIS |
| AI cục bộ (Ollama) | Chạy model trên Ollama của chính máy đó (`127.0.0.1:11434`). Cần cài Ollama và tải model, ví dụ `ollama pull llama3.2`. Worker tự nhận ra trong vòng 5 phút |
| Việc thử | Đếm giây và báo tiến độ, để thử phân việc, hủy và chuyển máy |
| Xử lý ảnh | Đổi cỡ, gắn logo, chỉnh ảnh cho ảnh trong Kho nội dung gốc (thư viện sharp, có sẵn) |
| Xử lý video | Cắt đoạn, đổi tỉ lệ khung hình, gắn logo, giảm nhiễu, tăng nét, lồng giọng đọc, làm ảnh bìa. Cần FFmpeg: trên Windows chạy `winget install --id Gyan.FFmpeg -e` rồi mở lại cửa sổ (hoặc đặt `FFMPEG_PATH` tới `ffmpeg.exe`) |
| Chạy mã trong sandbox | Chạy Python hoặc Node.js trong container Docker cách ly. Chỉ trên máy Code Runner có `--allow-code` (xem bên dưới) |

Giao việc ở **Hạ tầng → Việc của Worker**. Máy nhận việc khi đang hoạt động, còn chỗ trống, RAM và ổ đĩa chưa đầy. Máy tắt hay mất mạng quá 60 giây thì việc tự chuyển sang máy khác, tối đa 3 lần. Bấm Ctrl+C khi đang chạy việc thì việc cũng được trả về hàng đợi.

## Máy chạy mã (Code Runner)

Chỉ dùng cho máy bạn đồng ý cho chạy mã. Cần ba điều:

1. Thiết bị được tạo với loại **Code Runner** trên trang Hạ tầng. Máy loại khác không bao giờ nhận việc chạy mã.
2. Docker Desktop đã cài và đang chạy (“Engine running”).
3. Chạy Worker bằng lệnh:

```
pnpm worker run --allow-code
```

Lần đầu Worker tải hai ảnh `python:3.12-alpine` và `node:22-alpine` (khoảng 100 MB). Dòng “Nhận các loại việc” có `code.run` là sẵn sàng.

Mỗi lần chạy là một container mới, xóa ngay khi xong: không có mạng, không đọc hay ghi được file của máy, tối đa 256 MB RAM, 1 nhân CPU, 64 tiến trình, quá giờ thì bị dừng. Chỉ người có quyền “chạy mã” (`infra.code`, mặc định chủ và quản trị) mới giao được việc này.

## Địa chỉ máy chủ

- Máy chủ trên Internet phải dùng `https://`. Worker từ chối `http://` để khóa không bị lộ trên đường truyền.
- `http://` chỉ được dùng cho chính máy đó (`localhost`) hoặc mạng nội bộ (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`).

## Thu hồi và chuyển máy

- **Thu hồi khóa:** khóa hết hiệu lực ngay. Worker trên máy đó tự dừng ở lần báo kế tiếp. Thiết bị đã thu hồi không ghép nối lại được; tạo thiết bị mới.
- **Tạo chuỗi ghép nối mới:** dùng khi chuyển Worker sang máy khác. Khi Worker dùng chuỗi mới, khóa cũ hết hiệu lực.
- **Tạm dừng:** máy vẫn báo cáo nhưng không nhận việc mới. Việc đang chạy vẫn chạy tiếp.

# Extension SDK: làm Plugin cho MARIS

Plugin là một tệp JSON định dạng `maris.plugin/v1`. Tệp gói nhiều Skill, Connector và Workflow cùng một bản khai. Plugin chỉ chứa phần khai báo, không chứa mã chạy.

## Cấu trúc tệp

| Trường | Ý nghĩa |
| --- | --- |
| `format` | Luôn là `maris.plugin/v1` |
| `key` | Mã Plugin: chữ thường không dấu, số, `-`, `_` |
| `name`, `description`, `author`, `homepage` | Tên, mô tả, tác giả, trang https (không bắt buộc) |
| `version` | Phiên bản dạng `1.0.0` |
| `permissions` | Quyền xin. Phải đúng và đủ quyền mà các thành phần cần (xem bảng dưới) |
| `dependencies` | Plugin khác cần có: `{ "key": "…", "version": "^1.0.0" }` |
| `compatibility.maris` | Phiên bản MARIS chạy được, ví dụ `>=0.12.0` |
| `resources.maxRunUsd` | Chi phí AI tối đa một lần chạy của bất kỳ thành phần nào (tối đa $5) |
| `timeoutSec` | Thời gian tối đa của bất kỳ thành phần nào (10–600 giây) |
| `contents.skills` | Danh sách tệp Skill `maris.skill/v1` |
| `contents.connectors` | Danh sách tệp Connector `maris.connector/v1` (không chứa khóa, chỉ tên secret) |
| `contents.workflows` | Danh sách tệp Workflow `maris.workflow/v1` |
| `tests` | Bài kiểm tra. Cần ít nhất một, và mỗi Workflow cần một bài |
| `checksum` | SHA-256 của nội dung, SDK tự điền |
| `signature` | Chữ ký Ed25519, SDK tự điền khi ký |

Ô nhập và kết quả (input/output schema) là của từng thành phần: ô nhập của Skill, ô Bắt đầu của Workflow và ô nhập của mỗi thao tác Connector.

### Quyền

| Quyền | Khi nào cần |
| --- | --- |
| `ai.generate_text` | Có Skill, hoặc Workflow có bước AI hay Skill |
| `connector.read` | Connector có thao tác chỉ đọc |
| `connector.write` | Connector có thao tác gửi hay thay đổi bên ngoài |
| `webhook.receive` | Có Connector nhận Webhook |
| `workflow.run` | Có Workflow |

MARIS từ chối Plugin xin thiếu quyền, và cả Plugin xin quyền không dùng tới.

### Bài kiểm tra

```json
{ "kind": "skill", "name": "Đủ ô nhập", "key": "plugin-tra-loi-danh-gia", "inputs": { "khach_hang": "Lan" } }
{ "kind": "connector", "name": "Dựng được yêu cầu", "key": "kho-danh-gia", "capability": "danh_gia_moi", "inputs": { "shop": "a" } }
{ "kind": "workflow", "name": "Chạy hết", "key": "plugin-xu-ly-danh-gia", "inputs": { "khach_hang": "Minh" } }
```

Bài kiểm tra chạy trên máy chủ MARIS khi cài và khi bật. Chúng không gọi AI, không gọi ra ngoài và không tốn tiền:

- **Skill:** kiểm tra ô nhập.
- **Connector:** dựng yêu cầu mà không gửi đi.
- **Workflow:** chạy thử tới bước cuối và phải nằm trong `resources.maxRunUsd`.

Ví dụ đầy đủ: `PLUGIN_SAMPLES` trong `packages/contracts/src/plugins.ts`.

## Lệnh

Chạy ở thư mục gốc của dự án, sau `pnpm build`:

```
pnpm ext keygen cong-ty-abc
pnpm ext check plugin.json
pnpm ext pack plugin.json
pnpm ext sign plugin.json cong-ty-abc.key cong-ty-abc
pnpm ext verify plugin.json cong-ty-abc.pub
```

- `keygen` tạo hai tệp. `cong-ty-abc.key` là khóa riêng: giữ kín, không đưa vào kho mã. `cong-ty-abc.pub` là khóa công khai để gửi cho khách.
- `check` kiểm tra trường, quyền, checksum và tương thích.
- `pack` điền giá trị mặc định và checksum.
- `sign` đóng gói rồi ký. Tham số thứ ba là mã khóa, ghi vào chữ ký.
- `verify` kiểm tra chữ ký bằng khóa công khai.

Có thể dùng trong mã:

```ts
import { definePlugin, signPlugin, verifyPluginSignature } from '@maris/sdk';
```

## Cài và bật trong MARIS

1. Người nhận vào **Trung tâm Plugin → Nhà phát hành tin cậy** và thêm khóa công khai của bạn, đúng mã khóa đã dùng khi ký. Hai bên so vân tay với nhau.
2. **Cài từ tệp.** Mọi thành phần vào ở trạng thái tắt.
3. Người có quyền duyệt xem quyền và kết quả kiểm tra rồi bấm **Kích hoạt**. Plugin chưa ký hoặc ký bằng khóa chưa tin cậy chỉ bật được khi người duyệt đánh dấu chấp nhận. Việc chấp nhận được ghi vào nhật ký.
4. **Cập nhật:** cài tệp phiên bản mới và chọn “Cập nhật nếu Plugin cùng mã đã cài”. Plugin tắt cho tới khi được bật lại. Có thể quay về phiên bản cũ.

Tệp bị sửa sau khi ký sẽ bị từ chối khi cài, vì checksum hoặc chữ ký không khớp.

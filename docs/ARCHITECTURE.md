# Kiến trúc

Modular Monolith: một ứng dụng NestJS (`apps/api`) chứa mọi module, ranh giới rõ theo thư mục;
một ứng dụng Next.js (`apps/web`) cho Web, Mobile Responsive và Desktop (Tauri bọc cùng mã, Giai đoạn 11).

## Luồng một request có tenant

1. `AuthGuard`: `Authorization: Bearer <token>` → băm SHA-256 → tra `identity.sessions` còn hạn.
2. `TenantGuard`: đọc `X-Tenant-Id`, kiểm tra người dùng là thành viên tenant đó, nạp quyền của vai trò, kiểm tra `@RequirePermission`.
3. Service gọi `DbService.withContext({ userId, tenantId })`: mở transaction, `set_config('app.tenant_id', …, true)` (tương đương SET LOCAL), mọi truy vấn chịu RLS.
4. Thay đổi dữ liệu ghi `security.audit_logs` trong cùng transaction.

## Sự kiện (outbox)

Thay đổi nghiệp vụ ghi một dòng vào `work.outbox_events` trong cùng transaction. `OutboxService` (mỗi giây) chuyển các dòng chưa gửi
sang hàng đợi BullMQ `maris-events` với `jobId` = id sự kiện, rồi đánh dấu đã gửi. Sự kiện có thể đến hơn một lần, nên consumer phải idempotent.
Tên sự kiện: `<module>.<đối tượng>.<quá khứ>`, ví dụ `identity.member.added`, `security.secret.created`.

## AI Gateway (Giai đoạn 3)

`apps/api/src/ai`: mỗi loại nhà cung cấp là một adapter (`adapters.ts`) đổi lịch sử chat chung sang API riêng và đọc stream SSE về
dạng chữ + token. `AiRouterService` thử lần lượt các provider đang bật theo `priority` (provider được chọn cho hội thoại đứng đầu):
lỗi tạm thời (429, 5xx, mạng, timeout) thử lại một lần với backoff rồi chuyển provider; 401/403 chuyển provider ngay; 400 dừng
(không dùng provider khác để né từ chối). Khi đã có chữ gửi tới người dùng thì không chuyển nữa, để không trả lời hai lần.
Circuit breaker lưu trên Redis nên mọi instance API cùng thấy. Key chỉ được giải mã ngay trước lượt gọi và không rời máy chủ.

Gửi tin nhắn: transaction 1 ghi tin người dùng + chỗ trống cho câu trả lời + audit; stream không giữ transaction;
transaction 2 ghi câu trả lời, mọi lượt gọi provider và sự kiện `ai.message.completed`.

System prompt được ghép theo thứ tự cố định (`systemPrompt()` trong `chat.service.ts`): quy tắc an toàn của MARIS → Agent
(vai trò, prompt, tiêu chí) → chế độ chat → bộ nhớ dự án trong thẻ `<project_memory>` → câu nhắc rằng quy tắc đầu luôn ưu tiên.
Prompt của Agent và bộ nhớ là dữ liệu của tenant nên không thể bỏ quy tắc an toàn. Agent và dự án dùng chung trong tenant;
mỗi lần sửa Agent tăng `version` và lưu ảnh chụp cấu hình vào `ai.agent_versions` (chỉ INSERT).

Structured Task (`tasks.service.ts`): duyệt xong thì đưa `{tenantId, taskId, userId người duyệt}` vào BullMQ `maris-tasks`; worker
chạy với ngữ cảnh tenant của người duyệt (RLS vẫn áp dụng), nhận việc bằng cập nhật có điều kiện `queued → running`. Tạm dừng,
hủy và Dừng khẩn cấp đặt cờ Redis (`ai:task:abort:<id>`, `ai:estop:<tenant>`), `ControlService.watch` kiểm tra mỗi 0,5 giây và
ngắt lời gọi AI. Bảng `ai.controls` là nguồn sự thật cho Dừng khẩn cấp; cờ Redis chỉ đặt sau khi transaction đã commit.
Cost Governor đọc chi phí tháng từ `ai.provider_calls` trước mỗi lượt chat và mỗi lần chạy việc.

Model Registry (`models.service.ts`, `applyRegistry`): sau khi xếp thứ tự provider, mỗi ứng viên chưa bị ghim model sẽ đổi sang
model đang bật có khả năng mà chế độ chat cần (`MODE_CAPABILITY`), model tắt bị bỏ, giá của model gắn vào ứng viên và router
dùng giá đó thay giá provider. Thứ tự: `orderCandidates` → `applyRegistry` → `CostGovernor.filter`.

Hội đồng AI (`council.service.ts`): hàng đợi `maris-council`. Mỗi bước (trả lời, phản biện, tổng hợp) lấy lại ứng viên của từng
thành viên (provider còn bật, registry, ngân sách), gọi router song song với một ứng viên mỗi thành viên (bước tổng hợp dùng các
thành viên làm dự phòng), ghi `ai.council_turns` và `ai.provider_calls` (`council_id`). Chi phí cộng dồn bằng SQL vì các lượt
chạy song song. Câu trả lời của AI khác được đưa vào trong thẻ `<answer>`/`<critique>` (đã lọc thẻ) như dữ liệu, không như lệnh.

Tệp (`files.service.ts`, `apps/api/src/files`): `POST /ai/files` nhận thân request thô (`application/octet-stream`, tên trong
`X-File-Name`), đọc tới giới hạn rồi `detectType` đoán loại từ nội dung. Byte ghi vào `LocalFileStorage` (ghi tệp tạm rồi đổi
tên; khóa chỉ được là `<uuid>/<uuid>`), hàng `ai.files` và audit ghi trong một transaction; transaction lỗi thì xóa byte. Khi gửi
tin, `FilesService.attach` (trong transaction 1) kiểm tra tệp thuộc người gửi, gắn tệp vào tin nhắn và tạo phần thêm cho lượt
người dùng: văn bản trong `<attached_file>`, ảnh thành `ChatTurn.images` mà mỗi adapter đổi sang dạng ảnh của nhà cung cấp. Tin
nhắn lưu trong DB chỉ giữ chữ người dùng gõ.

AI Tổng điều hành (`plans.service.ts`): hàng đợi `maris-plans` với hai loại việc. `plan`: gửi mục tiêu (trong `<goal>`) và danh
sách Agent đang bật kèm mức quyền (trong `<agents>`), yêu cầu trả JSON; `parsePlan` kiểm tra bằng Zod, đối chiếu Agent thật và
mức quyền (`levelAtLeast`), thu ngân sách cho vừa tổng. Không có gì chạy từ kế hoạch: `accept` tạo các công việc `pending` qua
`TasksService.insert` trong một transaction (cập nhật có điều kiện `proposed → accepted` chống tạo trùng). `report`: khi mọi việc đã
kết thúc, gửi kết quả từng việc trong `<task_result>`. Mức quyền Agent chỉ đổi qua `PATCH /ai/agents/:id` (`ai.manage`) và được
kiểm tra lại khi công việc chạy.

## Dữ liệu

- PostgreSQL 16, mỗi module một schema. Hiện có `identity`, `security`, `work`, `ai`, `maris_ctx` (hàm ngữ cảnh).
- Khóa chính UUIDv7 sinh ở ứng dụng.
- File SQL trong `packages/db/migrations` là nguồn chuẩn; `schema.ts` (Drizzle) phản chiếu để truy vấn có kiểu.

## Quyết định

Xem `docs/adr/`.

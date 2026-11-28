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

Skill (`skills.service.ts`, Giai đoạn 4): bản ghi khai báo trong `ai.skills`, không có mã chạy. `run` kiểm tra ô nhập
(`checkInputs`), dựng lời nhắc với từng giá trị bọc trong `<skill_input>` (`skillPrompt`) rồi tạo công việc `pending` qua
`TasksService.insert`, kèm `skill_id`, `skill_version`, lời nhắc và `timeout_sec`; khi chạy, bộ đếm giờ hủy lệnh gọi AI và ghi
`TASK_TIMEOUT`. Checksum là SHA-256 của `canonicalJson` (khóa sắp xếp) phần thân manifest không gồm `checksum`; `import`
kiểm tra Zod, quyền (`ai.generate_text`), phụ thuộc rỗng và checksum, rồi lưu Skill ở trạng thái `paused`.

Workflow (`apps/api/src/workflows`, Giai đoạn 4): định nghĩa ở `work.workflow_definitions`, các bước ở `work.workflow_versions`
(mỗi lần lưu một bản, lần chạy giữ phiên bản lúc bắt đầu). `WorkflowRunsService.advance` chạy trên hàng đợi `maris-workflows`,
khóa dòng lần chạy (`FOR UPDATE`) rồi đi qua các bước cho tới khi phải chờ: bước AI/Skill tạo công việc đã duyệt sẵn
(`TasksService.insert` với `approvedBy` = người bắt đầu) và chờ; `TasksService.onFinished` báo khi công việc kết thúc để chạy tiếp.
Bước Duyệt đặt trạng thái `waiting_approval`; bước Chờ dùng job trễ của BullMQ. `steps_taken` so với `maxSteps` chặn vòng lặp,
`budget_usd` chặn chi phí. Điểm lưu ghi `{nodeId, outputs}` để `restore` chạy tiếp mà không làm lại các bước trước.
`simulate` (chạy thử) là hàm thuần, không ghi gì.

Connector (`apps/api/src/connectors`, Giai đoạn 4): khai báo ở `integration.connectors` (địa chỉ, `auth` trỏ tên secret, danh sách
thao tác). `buildRequest` là hàm thuần dựng yêu cầu từ thao tác và ô nhập; `connectorRequest` gửi bằng `node:http(s)` với `lookup`
riêng từ chối địa chỉ nội bộ lúc kết nối, không theo redirect, có hạn giờ và giới hạn dung lượng. Mỗi lần gọi có một dòng
`connector_calls` (`pending` → `ok`/`failed`): `prepare` ghi dòng trong transaction, `execute` gọi ra ngoài **sau** khi transaction
đóng rồi ghi kết quả và audit. Bước Connector của Workflow chờ với `wait = {kind:'connector', callId}`; khi gọi xong, run được
xếp lại hàng đợi. Webhook vào (`workflows/webhook-intake.ts`) không có phiên đăng nhập: mã `X-Maris-Token` so khớp SHA-256
bằng `timingSafeEqual`, rồi `WorkflowRunsService.start` chạy dưới tên người đã kích hoạt Connector.

Plugin (`apps/api/src/plugins`, Giai đoạn 4): một tệp `maris.plugin/v1` gói Skill, Connector và Workflow. `PluginsService.installIn`
chạy trong **một** transaction: kiểm tra checksum và chữ ký bằng `@maris/sdk`, chạy bài kiểm tra (`plugin-tests.ts`, hàm thuần dùng
`checkInputs`, `buildRequest`, `simulate`), rồi gọi `importIn` của từng service (cùng kiểm tra như khi nhập tệp lẻ) và ghi
`ext.plugin_components`. Kích hoạt gọi `setStatusIn`/`activateIn` của từng thành phần. Plugin không có mã chạy, nên không cần
sandbox; Plugin chạy mã sẽ đợi Giai đoạn 5. `packages/sdk` dùng chung cho API và người làm Plugin (lệnh `pnpm ext`).

Thiết bị và Worker (`apps/api/src/devices`, `apps/worker`, Giai đoạn 5): Worker luôn gọi ra máy chủ (đặc tả Phần 26), không có
kết nối vào máy người dùng. `DeviceAgentController` (`/agent/pair`, `/agent/heartbeat`) không có phiên đăng nhập; tenant lấy từ
chuỗi ghép nối hoặc khóa thiết bị rồi chạy trong `db.withContext({tenantId})`, như Webhook vào. Chuỗi ghép nối và khóa chỉ lưu
SHA-256. Mỗi nhịp báo ghi một dòng `infra.device_metrics`, sinh sự kiện khi có cảnh báo mới hoặc khi kết nối lại, và xóa chỉ số
cũ hơn 24 giờ. Trạng thái trực tuyến tính lúc đọc từ `last_seen_at`, không cần tiến trình nền.

Việc của Worker (`devices/worker-jobs.service.ts`, Sprint 14): Worker kéo việc (`claim`), không có kết nối đẩy vào máy. Mỗi
việc là một loại cố định trong `WORKER_JOB_KINDS`; Worker thực hiện bằng mã của chính nó (`apps/worker/src/jobs.ts`). Nhận việc
dùng `SELECT … FOR UPDATE SKIP LOCKED` và ghi hạn thuê (`lease_expires_at`); báo tiến độ gia hạn. `sweep()` trả việc hết hạn thuê
về hàng đợi hoặc báo lỗi, và dừng việc quá giờ; hàm chạy trong transaction của lần hỏi việc hay lần đọc danh sách kế tiếp.

Sandbox chạy mã (Sprint 15): `code.run` là loại việc duy nhất chạy mã người dùng. Máy chủ kiểm tra quyền `infra.code`, ép
`target_kinds = ['code_runner']` và lọc `code.run` khỏi khả năng của thiết bị không phải Code Runner (lúc nhận nhịp báo và lúc
nhận việc). Worker (`apps/worker/src/sandbox.ts`) gọi `docker run` bằng `spawn` không qua shell, với container không mạng, chỉ
đọc, giới hạn RAM/CPU/tiến trình, không capability, người dùng không đặc quyền. Một chương trình khởi động cố định đọc
`<số byte>\n<mã>` từ stdin rồi chạy mã, phần stdin còn lại để cho chương trình.

Giám sát (`devices/system-monitor.service.ts`, Sprint 15): chỉ đọc, không ghi audit. Phần của cả bản cài (tiến trình API,
PostgreSQL, Redis, hàng đợi BullMQ) đọc qua kết nối chung; phần của tenant (hoạt động, outbox, việc Worker, thiết bị, lỗi gần
đây) đọc trong `withContext` nên RLS áp dụng. `buildChecks()` là hàm thuần biến số liệu thành các mục kiểm tra.

## Kho nội dung (Giai đoạn 6)

`apps/api/src/content` (Sprint 16, đặc tả Phần 11). Tệp gốc và tệp của phiên bản thành phẩm nằm ở
`FILE_STORAGE_DIR/content/<tenant>/<uuid>`, ghi bằng `LocalFileStorage.putStream`: truyền thẳng xuống tệp tạm, băm
SHA-256, giữ 64 KB đầu để nhận dạng loại, rồi mới đổi tên khi bản ghi đã vào database. Kiểm tra trùng dùng
`pg_advisory_xact_lock` theo tenant và SHA-256. `content.assets_keep_original` (trigger) chặn mọi thay đổi bản gốc;
`content.item_versions` chỉ được INSERT. Duyệt kiểm tra quyền sử dụng của mọi nguồn trong phiên bản hiện tại.

AI viết nội dung (Sprint 17, đặc tả Phần 13): `ContentAiService` dựng lời nhắc từ thông tin sản phẩm đã xác minh và
tạo một việc AI (`TasksService.insert` với `content`, duyệt sẵn bởi người yêu cầu), nên dùng chung AI Router, ngân sách,
Dừng khẩn cấp và ghi chi phí. Khi việc xong, `TasksService.onFinished` gọi `ContentAiService.finish`: lưu chữ thành
phiên bản mới (`ai_task_id`) và chạy `factWarnings` so với `content.generations.allowed_text` (thông tin sản phẩm, yêu
cầu, tiêu đề). Cảnh báo của phiên bản hiện tại chặn duyệt. Việc AI viết nội dung không chạy lại được; tạm dừng hay Dừng
khẩn cấp sẽ kết thúc lượt viết.

Xử lý ảnh (Sprint 18): `ContentMediaService` kiểm tra ảnh và logo (loại, quyền, cỡ) rồi tạo việc Worker `media.image`
qua `WorkerJobsService.createIn(..., { internal: true })` trong cùng transaction với audit. Worker (`apps/worker/src/image.ts`,
thư viện sharp) chỉ tải được ảnh và logo ghi trong việc, khi chính máy đó đang chạy việc (`runningJob`), và gửi từng ảnh
kết quả lên `agent/jobs/:id/outputs`. Máy chủ nhận dạng lại tệp, khóa việc (`lockRunningIn`), tạo thành phẩm và phiên bản
có `worker_job_id`, ghi `content.media_outputs` (duy nhất theo việc và cỡ ảnh) và audit, với người tạo việc là người thực
hiện.

Xử lý video (Sprint 19) đi cùng đường đó với việc `media.video`: Worker (`apps/worker/src/video.ts`) gọi FFmpeg/ffprobe
của máy, tải tệp ra thư mục tạm theo luồng, dựng lệnh FFmpeg bằng hàm thuần `videoArgs` (không ghép chuỗi lệnh shell) và
gửi từng video cùng ảnh bìa (`preset=cover`). Giọng đọc lồng vào là một thành phẩm âm thanh; việc ghi `voiceVersion` lúc
giao để Worker chỉ tải đúng phiên bản đó (`agent/jobs/:id/items/:itemId`).

Giọng đọc AI (Sprint 19): `ContentVoiceService` gọi `/audio/speech` của AI Provider loại OpenAI (kiểm tra địa chỉ bằng
`url-guard`, khóa đọc từ Secret Vault, Cost Governor lọc theo ngân sách), ghi `ai.provider_calls` có `content_item_id`,
rồi lưu tệp thành thành phẩm âm thanh chuyển thể từ mục văn bản, cùng audit trong một transaction.

Kiểm định (Sprint 20): `qaReport` trong `content-qa.ts` là hàm thuần, chạy trên phiên bản hiện tại mỗi lần đọc chi tiết,
gửi duyệt và duyệt; không có bảng kết quả nên đổi quy tắc là có hiệu lực ngay. Cỡ và thời lượng tệp do `mediaInfo`
(`files/media-info.ts`) đọc từ 64 KB đầu mà `putStream` đã giữ, lưu vào cột của `item_versions`. Lỗi kiểm định nằm
trong `approvalBlockers` và chặn `submit`; audit ghi `qa: {status, codes}`.



## Trung tâm Meta và API Governor (Giai đoạn 7)

`apps/api/src/meta` (Sprint 21, đặc tả Phần 14–15). `MetaService` giữ Meta App của tenant (`meta.apps`), kết nối Facebook
(`meta.connections`, một kết nối chưa gỡ mỗi tenant) và tài sản (`meta.assets`). Token được niêm phong bằng
`SecretVaultService.sealFor` với dữ liệu gắn kèm `<tenant>:<meta-user|meta-page>:<id dòng>`. Trạng thái OAuth nằm trong
Redis (`meta:oauth:<sha256>`, 10 phút, lấy ra một lần bằng GETDEL).

Mọi lượt gọi Graph API đi qua `MetaGraphService.call`: đọc thông tin xác thực trong một transaction ngắn, rồi kiểm tra lệnh
dừng của Meta (`meta:block:<tenant>:<all|nhóm>`), ngắt mạch (`meta:cb:*`) và ngân sách 24 giờ đếm từ `integration.api_calls`
theo luật thuần trong `governor.ts`. Lượt đọc có `cacheSec` dùng cache Redis và gộp lượt trùng trong tiến trình. Sau mỗi lượt,
header hạn mức được lưu (`meta:usage:<tenant>`, coi là cũ sau 1 giờ), lượt gọi được ghi (chỉ đường dẫn), và lỗi được phân
loại theo mã Graph. Token đi trong header `Authorization`, kèm `appsecret_proof`. `META_GRAPH_URL` và `META_DIALOG_URL`
chỉ đổi khi kiểm thử.

- PostgreSQL 16, mỗi module một schema. Hiện có `identity`, `security`, `work`, `ai`, `integration`, `ext`, `infra`, `content`, `meta`, `maris_ctx` (hàm ngữ cảnh).
- Khóa chính UUIDv7 sinh ở ứng dụng.
- File SQL trong `packages/db/migrations` là nguồn chuẩn; `schema.ts` (Drizzle) phản chiếu để truy vấn có kiểu.

## Quyết định

Xem `docs/adr/`.

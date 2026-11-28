# Trạng thái dự án

Cập nhật: 2026-11-27 · Giai đoạn hiện tại: **6 – Content Factory (Sprint 19)**

| Giai đoạn | Trạng thái |
| --- | --- |
| 0–1. Audit và Architecture | Xong (báo cáo đã duyệt Q1–Q6) |
| 2. Core Platform | Sprint 1, 2 và màn hình quản trị đã merge; còn vài mục nhỏ (bên dưới) |
| 3. AI Central Command | Xong: Sprint 3–8 đã merge. [Báo cáo nghiệm thu](docs/phases/phase-3-ai-central-command.md) |
| 4. Skills, Workflow, Connector, Plugin | Xong: Sprint 9–12 đã merge. [Báo cáo nghiệm thu](docs/phases/phase-4-open-ecosystem.md). Plugin chạy mã chờ sandbox ở Giai đoạn 5 |
| 5. Hạ tầng | Xong: Sprint 13–15 đã merge. [Báo cáo nghiệm thu](docs/phases/phase-5-infrastructure.md) |
| 6. Content Factory | Sprint 16 (kho nội dung), 17 (AI viết nội dung) và 18 (xử lý ảnh) đã merge; Sprint 19 (video và giọng đọc AI) đang review; kế tiếp: 20 kiểm định và nghiệm thu |
| 7–14 | Chưa bắt đầu |

## Sprint 1 (đã merge)

- Monorepo pnpm + Turborepo, Docker Compose (PostgreSQL 16 + pgvector, Redis, MinIO)
- Migration `0001`: schema `identity`, `security`, Row-Level Security theo tenant, role runtime `maris_app`
- Bootstrap Owner, đăng nhập, khóa tài khoản, MFA TOTP, Tenant qua `X-Tenant-Id`, RBAC 4 vai trò, audit log chuỗi hash
- Web: đăng nhập, khung giao diện 5 vùng; CI đầy đủ

## Sprint 2

- Migration `0002`: lời mời, Secret Vault, outbox, quyền `secrets.read` / `secrets.manage`
- Mời thành viên (token dùng một lần, 7 ngày), chấp nhận lời mời, đổi vai trò, gỡ thành viên
- Secret Vault chỉ ghi: `POST/GET/DELETE /api/v1/secrets`, trả về `secret://<id>`
- Outbox → BullMQ `maris-events`
- Rate limit trên Redis (toàn API, đăng nhập, chấp nhận lời mời, MFA)
- Phiên trình duyệt bằng cookie httpOnly + header chống CSRF; web không còn giữ token

## Màn hình quản trị (web)

- `/secrets`: thêm, xem danh sách, xóa key; giá trị không bao giờ hiển thị lại
- `/members`: mời (đường dẫn `/invite#token`, token nằm sau `#` nên không đi vào log máy chủ), đổi vai trò, gỡ, hủy lời mời
- `/invite`: người được mời đặt tên và mật khẩu, hoặc đăng nhập nếu đã có tài khoản

## Còn lại của Giai đoạn 2

- Gửi email lời mời (hiện Owner tự chia sẻ đường dẫn/token)
- next-intl (vi, en); audit cho sự kiện cấp người dùng (đăng nhập, bật MFA)
- Xoay vòng khóa `VAULT_MASTER_KEY` (cột `key_version` đã có)

## Sprint 3 – AI Gateway và AI Chat (Giai đoạn 3)

- Migration `0003`: schema `ai` (providers, conversations, messages, provider_calls), quyền `ai.chat` (mọi vai trò mặc định) và `ai.manage` (owner, administrator)
- Universal AI Provider Gateway: OpenAI, Anthropic (Claude), Gemini, Ollama, mọi API tương thích OpenAI (OpenRouter, DeepSeek, Qwen, Grok). Key lấy từ Secret Vault theo `secret://`
- AI Router: thứ tự dự phòng chỉnh trên giao diện, retry + backoff cho lỗi tạm thời, timeout theo thời gian im lặng, circuit breaker trên Redis (3 lỗi/60 giây → bỏ qua 30 giây). Chỉ chuyển AI trước khi có chữ đầu tiên; lỗi 400 không chuyển AI
- Chống SSRF cho base URL (https công khai; Ollama loopback; `AI_ALLOW_PRIVATE_URLS` cho mạng nội bộ), không theo redirect
- AI Chat: hội thoại riêng từng người (RLS theo user), stream SSE, dừng giữa chừng, lịch sử làm ngữ cảnh, system prompt không cho thực thi hành động
- Token và chi phí: ghi mỗi lượt gọi (kể cả lỗi) vào `ai.provider_calls`, giá theo USD/1 triệu token do người dùng nhập; `GET /api/v1/ai/usage`
- Web: `/chat`, `/ai` (AI Provider), khung AI Chat bên phải mọi trang

## Sprint 4 – AI Agent, chế độ chat, bộ nhớ dự án (Giai đoạn 3)

- Migration `0004`: `ai.agents` + `ai.agent_versions` (mỗi lần sửa lưu một phiên bản), `ai.projects`, `ai.memories`, cột `agent_id` / `project_id` / `mode` cho hội thoại; quyền mới `ai.memory` (owner, administrator, manager)
- AI Agent: tên, vai trò, prompt, Provider/Model riêng, tiêu chí đánh giá, trạng thái, phiên bản. 34 Agent mẫu theo Phần 09 cài bằng một nút (chạy lại không tạo trùng)
- Chế độ chat: Trao đổi, Nghiên cứu, Điều hành, Chuyên gia, Lập trình, Giám sát, Phát triển phần mềm
- Bộ nhớ dự án lưu trong MARIS (không phụ thuộc AI Provider), mục ghim đọc trước, tối đa 16.000 ký tự mỗi lượt; được rào trong `<project_memory>` và luôn đứng sau quy tắc an toàn của MARIS
- Thứ tự chọn AI: Provider chọn trong hội thoại > Provider của Agent > thứ tự dự phòng
- Web: `/agents`, `/memory`; chọn Agent, chế độ, dự án trong Chat; câu trả lời hiển thị chữ đậm, danh sách, mã (không chèn HTML thô)

## Sprint 5 – Giao việc có phê duyệt, Dừng khẩn cấp, Cost Governor (Giai đoạn 3)

- Migration `0005`: `ai.tasks`, `ai.budgets`, `ai.controls`, cột `task_id` cho `ai.provider_calls`; quyền mới `ai.approve` (owner, administrator)
- Structured Task: mục tiêu, phạm vi, quyền hạn (hiện chỉ `ai.generate_text`), ngân sách USD, tiêu chí hoàn thành, Agent, dự án. Chờ duyệt → duyệt → chạy trên hàng đợi BullMQ `maris-tasks` → hoàn thành / lỗi. Tạm dừng, chạy tiếp (cần `ai.approve`), hủy (người tạo hoặc người duyệt). Lấy công việc bằng `UPDATE … WHERE status='queued'` nên job trùng không chạy hai lần
- Dừng khẩn cấp: ai có `ai.chat` đều bấm được; chặn chat (HTTP 423) và duyệt việc, ngắt câu trả lời và công việc đang chạy trong khoảng 0,5 giây (cờ Redis), chuyển việc đang mở sang tạm dừng; chỉ `ai.approve` bật lại
- Cost Governor: ngân sách tháng (UTC) cho toàn tenant hoặc từng Provider; 80% gửi sự kiện `ai.budget.threshold_reached` một lần mỗi tháng; Provider hết ngân sách bị bỏ qua (chuyển AI dự phòng); tenant hết ngân sách thì chặn mọi AI (HTTP 402)
- Web: `/tasks`, nút “Giao việc” dưới câu trả lời trong chat, thanh Công việc đang chạy cập nhật mỗi 5 giây, nút Dừng khẩn cấp, ô ngân sách trên trang AI Provider
- Giới hạn: ngân sách của một công việc được kiểm tra trước mỗi lần chạy (một lần chạy có thể vượt một chút); nếu API dừng giữa lúc duyệt và lúc đưa vào hàng đợi, công việc nằm ở “chờ chạy” cho tới khi bấm Tạm dừng rồi Chạy tiếp

## Sprint 6 – Danh mục model và Hội đồng AI (Giai đoạn 3)

- Migration `0006`: `ai.models`, `ai.councils`, `ai.council_turns` (chỉ INSERT), cột `council_id` cho `ai.provider_calls`
- Model Registry và Capability Registry: mỗi model của một AI có khả năng (trò chuyện, suy luận sâu, lập trình, ngữ cảnh dài, đọc hình ảnh, nhanh, giá rẻ), giá riêng, ngữ cảnh tối đa, bật/tắt. Chế độ Lập trình và Phát triển phần mềm ưu tiên model “Lập trình”; Nghiên cứu, Chuyên gia và Giao việc ưu tiên “Suy luận sâu”. Model do người dùng hoặc Agent chọn thì giữ nguyên. Model tắt không bao giờ được dùng. Giá model thay giá AI khi tính chi phí và ngân sách
- Hội đồng AI (`/council`): 2–4 thành viên (AI + model) trả lời độc lập song song → phản biện lẫn nhau (tùy chọn, cần ít nhất 2 câu trả lời) → một AI tổng hợp (các thành viên khác là dự phòng). Giới hạn chi phí mỗi phiên kiểm tra trước mỗi bước; hủy bởi người tạo hoặc người duyệt; Dừng khẩn cấp ngắt phiên đang họp. Bản tổng hợp tách đồng thuận và bất đồng, và ghi rõ đồng thuận không phải bằng chứng (đặc tả Phần 10)
- Chạy trên hàng đợi BullMQ `maris-council`, cùng cờ `AI_TASK_WORKER_ENABLED`
- Giới hạn: một bước đang chạy có thể vượt giới hạn chi phí một chút vì giới hạn được kiểm tra giữa các bước; vòng lặp tự cải tiến (Planner → Worker → Grader → …) chưa làm

## Sprint 7 – Tải tệp lên và nhập bằng giọng nói (Giai đoạn 3)

- Migration `0007`: `ai.files` (tên hiển thị, loại phát hiện từ nội dung, kích thước, SHA-256, khóa lưu trữ, tin nhắn đính kèm, xóa mềm)
- Tệp lưu trên ổ đĩa của máy chủ (`FILE_STORAGE_DIR`, mặc định `./data/uploads`), dưới khóa `<tenant>/<id tệp>` do MARIS tạo; tên tệp người dùng không bao giờ thành đường dẫn. Giới hạn `FILE_MAX_MB` (mặc định 25). Giao diện `FileStorage` để thay bằng MinIO/S3 sau
- Loại tệp đoán từ nội dung (magic bytes), không tin tên tệp hay trình duyệt: ảnh PNG/JPG/GIF/WEBP, văn bản TXT/MD/CSV/JSON (phải là UTF-8), PDF, Word/Excel/PowerPoint, video MP4/MOV/WEBM, âm thanh MP3/M4A/WAV/OGG. HTML, SVG và tệp chạy được bị từ chối. Tải về luôn là tệp đính kèm với CSP `sandbox`
- Tệp chỉ người tải lên xem, tải về, xóa và đính kèm được. Nhật ký kiểm toán ghi loại và kích thước, không ghi tên tệp
- Chat: nút 📎 hoặc dán ảnh vào ô nhập để đính kèm (tối đa 8 tệp mỗi tin). AI đọc được ảnh (tới 5 MB, gửi dạng ảnh cho OpenAI/Anthropic/Gemini) và văn bản (tổng 100.000 ký tự, đặt trong thẻ `<attached_file>` như dữ liệu, không như lệnh). PDF, Office, video, âm thanh được lưu và ghi chú cho AI là chưa đọc được
- Nút 🎤: nhận dạng giọng nói tiếng Việt của trình duyệt (Edge, Chrome). Âm thanh đi tới dịch vụ nhận dạng của hãng trình duyệt, không qua MARIS; nút ghi rõ điều này
- Giới hạn: chưa đọc nội dung PDF/Word/Excel, chưa chép lời video/âm thanh; tệp chưa đính kèm không tự xóa. Sao lưu thư mục `data/uploads` cùng với `.env`

## Sprint 8 – AI Tổng điều hành và mức quyền Agent (Giai đoạn 3, đã merge)

- Migration `0008`: `ai.plans`; cột `access_level` cho `ai.agents`; `plan_id`, `step_index`, `required_level` cho `ai.tasks`; `plan_id` cho `ai.provider_calls`
- Mức quyền theo đặc tả Phần 06: Chỉ đọc < Phân tích < Lập kế hoạch < Chuẩn bị < Thực thi < Điều khiển < Phát triển < Phát hành. Chỉ người có `ai.manage` đổi được mức quyền của Agent (ghi audit riêng `ai.agent.access_level_changed`); AI không đổi được. Công việc ở giai đoạn này chỉ cần tối đa “Chuẩn bị” vì AI chỉ soạn văn bản. Agent dưới mức công việc cần thì bị từ chối khi tạo việc và khi chạy
- Trang `/command`: nhập mục tiêu kinh doanh, ngân sách và dự án → MARIS lập kế hoạch 1–8 bước (hàng đợi `maris-plans`), giao mỗi bước cho Agent đang bật có đủ quyền. Kế hoạch do AI trả về được kiểm tra lại: Agent không tồn tại hoặc thiếu quyền thì bỏ giao và ghi lý do; ngân sách các bước được thu lại cho vừa tổng
- Người tạo hoặc người duyệt bấm tạo công việc: mỗi bước thành một công việc chờ duyệt (một transaction, không tạo trùng). Duyệt từng việc như trước; trang hiện tiến độ và kết quả từng bước
- Khi mọi việc đã kết thúc, MARIS tổng hợp báo cáo (kết quả, việc chưa xong, rủi ro, đề xuất cải tiến, bước tiếp theo cần duyệt). Kết quả công việc được đưa vào thẻ `<task_result>` như dữ liệu
- Giới hạn: chưa sửa được từng bước trước khi tạo công việc (bỏ kế hoạch và lập lại); các bước chạy độc lập, chưa có thứ tự phụ thuộc; chưa có Skill/Workflow/Worker để chọn (Giai đoạn 4–5)

## Sprint 9 – Skill (Giai đoạn 4, đã merge)

- Migration `0009`: bảng `ai.skills` (RLS theo tenant); cột `skill_id`, `skill_version`, `skill_prompt`, `timeout_sec` cho `ai.tasks`
- Skill theo đặc tả Phần 23: mã, tên, phiên bản, tác giả, mô tả, ô nhập (văn bản, đoạn dài, số, lựa chọn), hướng dẫn cho AI, tiêu chí đạt, quyền xin, phụ thuộc, tương thích, ví dụ, mức quyền, ngân sách, thời gian tối đa, checksum, trạng thái
- Skill chỉ là khai báo: không chạy mã, không tự kết nối ra ngoài, quyền duy nhất được xin là `ai.generate_text`. Chạy Skill tạo một công việc chờ duyệt như mọi công việc khác; thời gian tối đa được áp khi chạy (quá giờ thì lỗi `TASK_TIMEOUT`)
- Trang `/skills`: thêm 6 Skill mẫu bán hàng, tạo/sửa (mỗi lần sửa tăng phiên bản và checksum), bật/tắt, xóa, xem chi tiết, chạy bằng biểu mẫu sinh từ ô nhập
- Xuất Skill ra tệp `.maris-skill.json`; nhập tệp có kiểm tra định dạng, quyền, phụ thuộc và checksum (tệp bị sửa sau khi xuất bị từ chối). Skill nhập vào luôn ở trạng thái tắt cho tới khi quản trị viên đọc và bật
- Dữ liệu người dùng nhập vào Skill được bọc trong thẻ `<skill_input>` như dữ liệu, không phải mệnh lệnh
- Chỉ `ai.manage` tạo, sửa, nhập, xóa Skill; ai có `ai.chat` xem, xuất và chạy được
- Giới hạn: chưa có phụ thuộc giữa các Skill, chưa có chữ ký số của tác giả (chỉ checksum), chưa có kho Skill chung; AI Tổng điều hành chưa tự chọn Skill

## Sprint 10 – Workflow Studio (Giai đoạn 4, đã merge)

- Migration `0010`: `work.workflow_definitions`, `work.workflow_versions` (không sửa được sau khi ghi), `work.workflow_runs`, `work.workflow_run_steps` (RLS theo tenant); cột `workflow_run_id`, `workflow_node_id` cho `ai.tasks`
- Các loại bước: Bắt đầu (ô nhập), AI, Skill, Điều kiện (7 phép so sánh, rẽ nhánh, quay lại để lặp), Duyệt, Chờ (tối đa 1 ngày), Điểm lưu, Kết thúc. Bước dùng `{{input.x}}` và `{{steps.y}}`; dữ liệu đưa cho AI được bọc trong `<workflow_data>`
- Trang `/workflows`: tạo, sửa từng bước (mỗi lần lưu là một phiên bản), sao chép, xuất/nhập tệp `maris.workflow/v1` (kiểm tra checksum, Skill và Agent phải có sẵn; nhập vào ở trạng thái tắt), khôi phục phiên bản cũ, 2 Workflow mẫu dùng Skill mẫu
- Chạy thử: đi theo dây chuyền với kết quả giả, không gọi AI, không tốn tiền, báo số bước AI và chi phí tối đa
- Chạy thật: chỉ người có `ai.approve` bắt đầu được; bắt đầu chạy là duyệt chi phí tới ngân sách đã nhập. Bước AI/Skill thành công việc đã duyệt sẵn (vẫn qua Dừng khẩn cấp, ngân sách tháng, mức quyền Agent). Bước Duyệt dừng chờ người có `ai.approve`
- Xem đầu vào, đầu ra, chi phí từng bước; tạm dừng, tiếp tục, hủy (hủy cả công việc AI đang chạy), chạy tiếp từ điểm lưu sau khi lỗi hoặc hủy
- Giới hạn số lượt chạy bước mỗi lần (mặc định 50, tối đa 200) chặn vòng lặp; ngân sách lần chạy chặn chi phí
- Giới hạn: thiết kế bằng danh sách bước (chưa kéo thả trên sơ đồ); chưa có bước Hẹn giờ, Dữ liệu, Song song, Gộp, Worker, Thông báo, Xử lý lỗi (cần sandbox); chưa chia sẻ giữa các workspace ngoài xuất/nhập tệp. Bước Connector và Webhook có từ Sprint 11

## Sprint 11 – Connector Hub (Giai đoạn 4, đã merge)

- Migration `0011`: schema `integration` với `connectors`, `connector_calls`, `webhook_events` (RLS theo tenant)
- Connector gọi API (REST; GraphQL qua POST): địa chỉ gốc, cách đăng nhập (Bearer, header riêng, tham số, khóa trong đường dẫn) lấy khóa từ Secret Vault theo **tên**, header cố định, thời gian tối đa (1–60 giây)
- Capability Registry: mỗi thao tác khai báo phương thức, đường dẫn, tham số, nội dung JSON, ô nhập và mức rủi ro (chỉ đọc / gửi ra ngoài). Ô nhập chỉ điền vào chỗ được đánh dấu: trong đường dẫn được mã hóa thành một đoạn (chặn `..`), trong JSON được thoát ký tự để không phá cấu trúc
- Permission Scope: quản lý (`ai.manage`) tạo, sửa, thử thao tác chỉ đọc; thử thao tác gửi ra ngoài và Kích hoạt cần `ai.approve`. Connector mới, mẫu, nhập từ tệp, hoặc vừa đổi địa chỉ/khóa/thao tác đều quay về “Chưa kích hoạt”. Dừng khẩn cấp chặn mọi lần gọi
- Chống SSRF: chỉ https tới địa chỉ công khai; địa chỉ IP được kiểm tra lúc kết nối (chống đổi DNS); không theo chuyển hướng; tối đa 256 KB kết quả. `CONNECTOR_ALLOW_PRIVATE_URLS=true` cho n8n trên máy hoặc mạng nội bộ
- Nhật ký gọi: địa chỉ đã che khóa, mã HTTP, thời gian, kết quả (khóa bị che nếu bên kia trả lại); audit mỗi lần gọi. Ô nhập không lưu vào nhật ký
- Bước **Connector** trong Workflow: gọi một thao tác của Connector đang bật, ô nhập dùng `{{input.x}}`/`{{steps.y}}`; kết quả là dữ liệu, được bọc `<workflow_data>` khi đưa cho AI. Chạy thử không gọi ra ngoài
- Connector **nhận Webhook**: `POST /api/v1/hooks/<tenant>/<connector>` với header `X-Maris-Token` (chỉ lưu SHA-256 của mã, mã hiện một lần, đổi mã là mã cũ hết hiệu lực); có thể chạy một Workflow dưới tên người đã Kích hoạt (phải còn `ai.approve`), chỉ lấy các ô trùng tên ô nhập, ngân sách mỗi lần tối đa $5; giới hạn 60 lần/phút mỗi IP
- 4 Connector mẫu: Telegram Bot, GitHub, n8n, Nhận đánh giá từ bên ngoài. Xuất/nhập tệp `maris.connector/v1` (không chứa khóa, kiểm tra checksum)
- Trang `/connectors` (mục M35): danh sách, Chuẩn bị trước khi kích hoạt, Thử gọi, Nhật ký gọi, Webhook (địa chỉ, mã bí mật, lần nhận gần đây); bước Connector trong trình thiết kế Workflow
- Giới hạn: chưa có OAuth (đăng nhập bằng tài khoản Google, Meta…), MCP Gateway, CLI Adapter, Local Worker; thao tác soạn bằng JSON; thao tác gửi ra ngoài trong Workflow không tự thử lại (tránh gửi trùng); nếu API dừng giữa lúc gọi, bước đó báo lỗi “bị ngắt giữa chừng”

## Sprint 19 – Xử lý video bằng FFmpeg và giọng đọc AI (Giai đoạn 6)

- Migration `0019`: cột `ai.provider_calls.content_item_id` (chi phí giọng đọc gắn với mục văn bản được đọc); chỉ mục việc `media.video` theo video gốc
- Giọng đọc AI (đặc tả Phần 12): `POST /api/v1/content/items/:id/voiceover` (`content.generate`) đọc phiên bản hiện tại của một mục văn bản (tối đa 4.096 ký tự) bằng giọng OpenAI (`gpt-4o-mini-tts`), qua AI Provider loại OpenAI đang bật, Dừng khẩn cấp và ngân sách AI; ghi vào `ai.provider_calls` và audit `content.voiceover.created`
- Sáu giọng: nữ (Nova sôi nổi, Coral ấm áp, Shimmer nhẹ nhàng) và nam (Onyx trầm chắc, Ash nam trẻ tự tin, Echo rõ ràng). Chế độ Tự động luân phiên nữ và nam, không dùng một giọng cho mọi video. Chỉnh được tốc độ (0,5–2×) và phong cách đọc; tiếng Việt và tiếng Anh có phong cách mặc định riêng
- Kết quả là một thành phẩm Âm thanh (bản nháp), “chuyển thể từ” mục văn bản, mang theo nguồn gốc của phiên bản được đọc
- Loại việc Worker mới `media.video`: cắt đoạn, đổi tỉ lệ khung hình (vuông 1:1, dọc 4:5, dọc 9:16, ngang 16:9, giữ khung gốc tối đa 4K), cắt cho vừa khung hoặc giữ trọn hình trên nền màu, giảm nhiễu, tăng nét, gắn logo, lồng giọng đọc (trộn với tiếng gốc nhỏ lại hoặc thay hẳn), làm ảnh bìa từ một khung hình; H.264 + AAC, bỏ metadata
- `POST /api/v1/content/assets/:id/process-video` (`content.manage`): chỉ cho video đã tải lên, không lưu trữ, không bị đánh dấu “Không được dùng”, tối đa 4 GB; logo phải là ảnh; giọng đọc phải là mục âm thanh có tệp, chưa bị từ chối hay lưu trữ (giữ đúng phiên bản lúc giao việc)
- Worker tải video, logo và giọng đọc của việc mình đang chạy (`GET /agent/jobs/:id/files/:assetId`, `GET /agent/jobs/:id/items/:itemId`) ra tệp tạm, gửi từng video và ảnh bìa lên (`preset=cover`). Máy chủ chỉ nhận video cho các tỉ lệ, ảnh cho ảnh bìa
- Mỗi tỉ lệ thành một thành phẩm Video (bản nháp), ảnh bìa thành một thành phẩm Hình ảnh; phiên bản ghi đoạn cắt, giọng đọc, logo, giảm nhiễu và máy làm
- MARIS Worker 0.19: tìm FFmpeg trên PATH hoặc `FFMPEG_PATH`, tự báo nhận việc video khi FFmpeg chạy được (có libx264); báo tiến độ theo phần trăm, dừng FFmpeg khi hủy
- Web: Kho nội dung gốc, chọn một video, phần “Xử lý video”; Kho thành phẩm, mục văn bản có phần “Giọng đọc AI”. Sửa: ô “Phiên bản mới” không còn giữ chữ của mục mở trước
- Giới hạn: chưa ghép nhiều đoạn video, chưa có phụ đề tự động, nhạc nền, AI tạo video; giá giọng đọc là ước tính theo số ký tự

## Sprint 18 – Xử lý ảnh trên Media Worker (Giai đoạn 6, đã merge)

- Migration `0018`: bảng `content.media_outputs` (RLS, mỗi việc và mỗi cỡ ảnh một kết quả); cột `content.item_versions.worker_job_id`
- Loại việc Worker mới `media.image` (đặc tả Phần 13 và 26): chuẩn hóa kích thước theo nền tảng (vuông 1:1, dọc 4:5, dọc 9:16 cho Story/Reels/TikTok, ngang 16:9, thumbnail YouTube 1280×720, giữ cỡ gốc), cắt theo phần chính của ảnh hoặc giữ trọn ảnh trên nền màu, gắn logo (vị trí, cỡ, độ đậm, cách mép), cân chỉnh ánh sáng nhẹ, tăng độ nét, xuất JPEG/WebP/PNG
- `POST /api/v1/content/assets/:id/process-image` (`content.manage`): chỉ cho ảnh đã tải lên, không lưu trữ, không bị đánh dấu “Không được dùng”, tối đa 50 MB; logo cũng vậy. `GET .../media-jobs` (danh sách việc và các Worker xử lý được), `POST /content/media-jobs/:id/cancel`
- Việc `media.image` chỉ tạo được từ kho nội dung (tạo hoặc chạy lại ở màn hình Việc của Worker bị từ chối `JOB_KIND_INTERNAL`)
- Worker chỉ tải được đúng ảnh và logo của việc mình đang chạy (`GET /agent/jobs/:id/files/:assetId`) và gửi kết quả (`POST /agent/jobs/:id/outputs?preset=`). Máy chủ nhận dạng lại tệp, chỉ nhận ảnh; gửi lại cùng cỡ trả về thành phẩm đã tạo
- Mỗi cỡ ảnh thành một thành phẩm loại Hình ảnh (bản nháp) có phiên bản 1 ghi nguồn gốc (ảnh gốc, logo), việc Worker và máy làm; duyệt như mọi thành phẩm
- MARIS Worker 0.18: dùng thư viện `sharp`, tự báo nhận việc xử lý ảnh khi thư viện chạy được; xoay ảnh theo EXIF, bỏ thông tin vị trí và metadata, từ chối SVG; giới hạn 100 megapixel
- Web: Kho nội dung gốc, chọn một ảnh, phần “Xử lý ảnh” (cỡ ảnh, logo, chỉnh ảnh, định dạng, thư mục, máy xử lý, danh sách việc và liên kết tới thành phẩm). Phiên bản ghi “do Media Worker xử lý”
- Giới hạn: chưa tách nền, thay nền, dịch chữ trên ảnh (cần AI hình ảnh); chưa xử lý hàng loạt nhiều ảnh một lần

## Sprint 17 – AI viết nội dung (Giai đoạn 6, đã merge)

- Migration `0017`: quyền `content.generate` (chủ, quản trị, quản lý); bảng `content.generations` (RLS); cột `content.items.variant_of` và `ai.tasks.content_item_id`
- AI viết phiên bản mới cho một thành phẩm (M13, đặc tả Phần 13): `POST /api/v1/content/items/:id/generate` với thông tin sản phẩm, văn bản tham khảo, yêu cầu thêm, giọng văn và ngân sách (mặc định 0,2 USD, tối đa 2 USD)
- Chỉ dùng thông tin sản phẩm đã xác minh: chọn thông tin chưa xác minh bị từ chối (`CONTENT_FACTS_UNVERIFIED`). Văn bản tham khảo “không được dùng” bị từ chối; tệp (PDF, video) chưa đọc được
- Mỗi lần viết là một việc AI đã duyệt sẵn bởi người yêu cầu, chạy qua AI Router (dự phòng khi AI chính lỗi), ngân sách, Dừng khẩn cấp và audit như mọi việc AI. Mỗi thành phẩm chỉ một lần viết cùng lúc; hủy được giữa chừng
- Hướng dẫn theo nền tảng: bài Facebook, chú thích Instagram, kịch bản TikTok/Reels, tiêu đề và mô tả YouTube, quảng cáo Google (tiêu đề 30, mô tả 90 ký tự), blog SEO, mô tả sản phẩm Shopify, email; quảng cáo Meta khi loại là Nội dung quảng cáo
- Kiểm tra sau khi viết: con số không có trong thông tin sản phẩm hoặc yêu cầu, và lời quảng cáo cần căn cứ (“tốt nhất”, “số 1”, “cam kết”, “chính hãng”…) bị ghi thành cảnh báo. Bản AI có cảnh báo không duyệt được cho tới khi người sửa và lưu phiên bản mới
- Kết quả là phiên bản mới (bản nháp), ghi việc AI, nguồn gốc, chi phí; luôn cần người duyệt
- Bản ngôn ngữ, thị trường hoặc nền tảng khác: `POST /api/v1/content/items/:id/variants` tạo thành phẩm mới liên kết với bản gốc, AI bản địa hóa (tiếng Việt ↔ tiếng Anh) hoặc chuyển thể từ chữ hiện tại và cùng thông tin sản phẩm
- Web: ở Kho thành phẩm, phần “AI viết phiên bản mới”, “Các lần AI viết” (tiến độ, chi phí, cảnh báo, Hủy) và “Bản ngôn ngữ hoặc nền tảng khác”
- Giới hạn: AI chưa đọc PDF hay video làm tài liệu; kiểm tra số liệu dựa trên so khớp chữ số, nên có thể báo nhầm (người sửa là xong); chưa tự tạo hàng loạt nhiều bản một lần

## Sprint 16 – Kho nội dung gốc và Kho thành phẩm (Giai đoạn 6, đã merge)

- Migration `0016`: schema `content` với `folders`, `assets` (nội dung gốc), `items` (thành phẩm), `item_versions` (RLS). Quyền `content.read` (mọi vai trò), `content.manage` (chủ, quản trị, quản lý), `content.approve` (chủ, quản trị)
- Kho nội dung gốc (M09, đặc tả Phần 11): video, ảnh, âm thanh, tài liệu tải lên; văn bản, tham khảo, thông tin sản phẩm (tên, SKU, giá, thông số) nhập tay. Mỗi mục ghi nguồn, quyền sử dụng (của doanh nghiệp, có giấy phép, được cho phép, chưa rõ, không được dùng), chủ sở hữu, hạn quyền, tag, thư mục
- Không ghi đè bản gốc: chỉ sửa được mô tả, thư mục, tag và quyền; trigger trong database chặn mọi thay đổi tệp, nội dung, thông tin sản phẩm. Lưu trữ thay vì xóa
- Tải tệp lớn: truyền thẳng xuống đĩa (mặc định tối đa 2 GB, `CONTENT_MAX_MB`), băm SHA-256 khi ghi, nhận dạng loại từ nội dung tệp. Trùng nội dung (cùng SHA-256) bị từ chối và chỉ ra bản đã có
- Xác minh thông tin sản phẩm (người có `content.approve`), để AI ở Sprint 17 chỉ dùng thông tin đã xác minh
- Kho thành phẩm (M10): loại, ngôn ngữ, thị trường, nền tảng. Mỗi lần sửa là phiên bản mới (văn bản hoặc tệp), phiên bản cũ giữ nguyên (chỉ cho INSERT). Mỗi phiên bản ghi nội dung gốc đã dùng, Skill (kèm phiên bản Skill), lượt Workflow, việc AI, người tạo
- Quy trình: Bản nháp → Chờ duyệt → Đã duyệt → Đã xuất bản (kèm đường dẫn), hoặc Bị từ chối, Lưu trữ. Không duyệt được khi một nguồn chưa rõ quyền, không được dùng hay hết hạn quyền. Sửa sau khi duyệt thì trở về bản nháp. Đã xuất bản thì khóa
- Tìm kiếm theo tên, mô tả, tag; lọc theo loại, quyền, thư mục, trạng thái, nền tảng; tra ngược thành phẩm nào dùng một nội dung gốc
- Tải về luôn kèm `Content-Security-Policy: sandbox` và `nosniff`; chỉ ảnh, video, âm thanh được xem ngay trong trang
- Web: `/content` (Kho nội dung gốc), `/content/items` (Kho thành phẩm)
- Giám sát: hàng đợi sự kiện `maris-events` (lưu cho dịch vụ sau, chưa có nơi nhận) không còn bị tính là ùn
- Giới hạn: chưa có AI viết nội dung (Sprint 17), chưa xử lý ảnh/video (Sprint 18–19), chưa nhập từ Connector tự động; lưu trữ trên đĩa máy chủ (S3/MinIO sau)

## Sprint 15 – Sandbox chạy mã và giám sát hệ thống (Giai đoạn 5, đã merge)

- Migration `0015`: quyền `infra.code` (“chạy mã”), chỉ cấp sẵn cho owner và administrator
- Loại việc `code.run`: chạy Python 3.12 hoặc Node.js 22. Mã tối đa 50.000 ký tự, stdin tối đa 10.000, thời gian tối đa 600 giây (mặc định 120)
- Ba lớp chặn: người giao phải có `infra.code` (cả khi Giao lại); máy chủ luôn ép việc về loại máy Code Runner và chỉ giao `code.run` cho thiết bị loại `code_runner`, dù Worker khác tự báo làm được; Worker chỉ nhận chạy mã khi chủ máy chạy `pnpm worker run --allow-code` và Docker đang chạy
- Sandbox: mỗi lần chạy một container Docker mới, xóa ngay sau khi xong: `--network none`, hệ thống file chỉ đọc (chỉ `/tmp` 64 MB trong RAM), RAM 256 MB không swap, 1 CPU, 64 tiến trình, bỏ mọi capability, `no-new-privileges`, người dùng 65534. Mã và stdin đi qua stdin, không nằm trên dòng lệnh. Quá giờ hay bị hủy thì `docker kill`
- Kết quả: mã thoát, thời gian, stdout và stderr (mỗi thứ tối đa 32 KB). Quá giờ là lỗi `CODE_TIMEOUT` nhưng vẫn giữ phần đã in ra. Audit ghi ngôn ngữ, số ký tự và SHA-256 của mã
- Giám sát hệ thống `GET /api/v1/system/monitor` (`infra.read`): máy chủ API (thời gian chạy, bộ nhớ), PostgreSQL (độ trễ, dung lượng, số kết nối), Redis (độ trễ, bộ nhớ), 5 hàng đợi BullMQ, sự kiện outbox tồn, hoạt động 24 giờ (gọi AI và tỉ lệ lỗi, việc AI, Workflow, Connector, việc Worker lỗi), thiết bị, 15 lỗi gần nhất. Máy chủ tự xếp từng mục Ổn định / Cần chú ý / Có lỗi. Mỗi phép đo có giới hạn thời gian nên Redis chết không làm treo trang
- Web: trang `/system` (M37 “Giám sát hệ thống”, tự làm mới mỗi 15 giây); trang Việc của Worker có ô chạy mã (chọn ngôn ngữ, mã mẫu, stdin, giới hạn thời gian) và hiển thị stdout/stderr
- Worker 0.15.0: `run --allow-code`, tự tải ảnh `python:3.12-alpine`, `node:22-alpine` lúc khởi động
- Giới hạn: chưa cài thư viện ngoài (pip/npm) trong sandbox, chưa nối Plugin hay bước Workflow với sandbox (Code Runner đầy đủ và AI Studio thuộc Giai đoạn 10); giám sát chưa gửi cảnh báo ra ngoài (email, Telegram)

## Sprint 14 – Giao việc cho Worker (Giai đoạn 5, đã merge)

- Migration `0014`: `infra.worker_jobs`, `infra.worker_job_logs` (RLS); thiết bị có thêm `max_jobs` (số việc chạy cùng lúc) và `capabilities` (loại việc Worker báo làm được)
- Loại việc cố định, cài sẵn trong chương trình Worker, không có loại nào chạy lệnh shell hay mã từ máy chủ: Kiểm tra máy (`diagnostics`), AI cục bộ qua Ollama trên chính máy đó (`ollama.generate`, địa chỉ cố định 127.0.0.1:11434), Việc thử (`test.wait`). Ô nhập được kiểm tra ở cả máy chủ và Worker
- Phân việc: Worker hỏi việc mỗi 5 giây (`POST /agent/jobs/claim`). Chỉ nhận khi thiết bị đang hoạt động, chưa đủ `max_jobs`, không có cảnh báo RAM hay ổ đĩa, có GPU mát nếu việc cần GPU, đủ RAM trống, đúng loại việc, đúng máy hoặc loại máy nếu có chỉ định. Ưu tiên cao trước, rồi việc cũ trước. `FOR UPDATE SKIP LOCKED` nên hai Worker không nhận trùng
- Thuê việc 60 giây, gia hạn mỗi lần báo tiến độ (10 giây một lần). Hết hạn thì việc về hàng đợi cho Worker khác (máy vừa mất việc chỉ nhận lại sau 60 giây), tối đa `max_attempts` lần rồi báo lỗi `WORKER_LOST`. Quá `timeout_sec` thì lỗi `JOB_TIMEOUT` và Worker được bảo dừng. Thu hồi hay xóa thiết bị thì việc đang chạy về hàng đợi ngay. Việc dọn này chạy mỗi khi Worker hỏi việc hoặc có người mở danh sách, không cần tiến trình nền
- Hủy (việc chờ dừng ngay, việc đang chạy dừng ở lần báo kế tiếp), Chuyển sang máy khác, Giao lại. Việc lỗi ghi sự kiện cảnh báo của thiết bị. Kết quả tối đa 64 KB. Thao tác của người dùng ghi audit
- Worker 0.14.0: `pnpm worker run` nhận việc (tự nhận ra Ollama), `pnpm worker run --monitor-only` chỉ báo cáo tài nguyên. Ctrl+C trả việc đang chạy về hàng đợi
- Trang `/infra/jobs` (mục M32 “Việc của Worker”): giao việc, tiến độ, máy đang chạy, số lần thử, nhật ký, kết quả (câu trả lời AI hiển thị như văn bản). Trang Hạ tầng thêm cột Việc (đang chạy/tối đa) và chỉnh số việc chạy cùng lúc
- Giới hạn: chưa chạy mã hay lệnh tùy ý (chờ sandbox Sprint 15); chưa nối Workflow với Worker; chưa có “khởi động lại dịch vụ được phép”

## Sprint 13 – Thiết bị và Worker (Giai đoạn 5, đã merge)

- Migration `0013`: schema `infra` với `devices`, `device_metrics`, `device_events` (RLS theo tenant); quyền `infra.read`, `infra.manage` cho owner và administrator
- Loại thiết bị theo đặc tả Phần 26: VPS điều hành trung tâm, máy quản trị, máy nhân viên, GPU Worker, Media Worker, AI Local Worker, Code Runner
- Ghép nối: người quản trị tạo thiết bị và nhận chuỗi ghép nối `maris1.…`, dùng một lần, hết hạn sau 30 phút. Worker đổi chuỗi lấy khóa thiết bị. Chỉ lưu SHA-256 của chuỗi và khóa, so bằng `timingSafeEqual`. Bộ cài không chứa tài khoản quản trị
- Worker (`apps/worker`, lệnh `pnpm worker pair|run|status`): chỉ kết nối ra máy chủ, không mở cổng, không nhận lệnh. Báo CPU, RAM, ổ đĩa, GPU NVIDIA (qua `nvidia-smi` nếu có), nhiệt độ CPU (Linux) mỗi 15 giây. Từ chối `http://` tới máy chủ ngoài mạng nội bộ. Khóa lưu ở `~/.maris-worker/config.json` (chỉ người dùng hiện tại đọc được)
- API Worker không cần phiên đăng nhập: `POST /agent/pair` (10 lần/phút mỗi IP), `POST /agent/heartbeat` với `X-Maris-Device` (240 lần/phút mỗi IP). Câu trả lời chỉ có trạng thái thiết bị
- Trực tuyến khi có nhịp báo trong 45 giây. Cảnh báo: ổ đĩa ≥ 90%, RAM ≥ 95%, GPU ≥ 85°C, CPU ≥ 90°C, mất kết nối. Nhật ký sự kiện: ghép nối, cảnh báo mới, kết nối lại, tạm dừng, thu hồi. Chỉ số giữ 24 giờ
- Tạm dừng / chạy lại (thiết bị tạm dừng vẫn báo nhưng sẽ không nhận việc ở Sprint 14), chuỗi ghép nối mới (khóa cũ hết hiệu lực khi dùng), thu hồi khóa (Worker tự dừng), đổi tên, xóa. Mọi thao tác ghi audit
- Trang `/infra` (mục M31): tình trạng máy chủ MARIS, danh sách thiết bị với CPU/RAM/ổ đĩa/GPU, biểu đồ 60 phút, sự kiện, cảnh báo
- Giới hạn: chưa phân việc cho Worker (Sprint 14), chưa có sandbox chạy mã (Sprint 15); GPU chỉ đọc được NVIDIA; chưa có bộ cài Worker đóng gói sẵn (chạy từ thư mục mã nguồn)

## Sprint 12 – Trung tâm Plugin và Extension SDK (Giai đoạn 4, đã merge)

- Migration `0012`: schema `ext` với `plugins`, `plugin_versions`, `plugin_components`, `trusted_publishers` (RLS theo tenant)
- Plugin (định dạng `maris.plugin/v1`) là một gói Skill, Connector và Workflow với một bản khai đủ các mục đặc tả Phần 23: mã, tên, phiên bản, mô tả, tác giả, quyền, phụ thuộc (khoảng phiên bản `*`, `1.2.3`, `>=1.2.3`, `^1.2.3`), tương thích MARIS, ngân sách tối đa mỗi lần chạy, thời gian tối đa, checksum, chữ ký Ed25519 và bộ bài kiểm tra. Ô nhập và kết quả là của từng thành phần
- Quyền của Plugin: `ai.generate_text`, `connector.read`, `connector.write`, `webhook.receive`, `workflow.run`. Plugin phải xin đúng và đủ quyền các thành phần cần; không có quyền chạy mã hay đọc cơ sở dữ liệu
- Cài (`ai.manage`): kiểm tra định dạng, checksum, chữ ký, giới hạn ngân sách và thời gian, chạy bài kiểm tra (không tốn tiền, không gọi ra ngoài), không đè lên Skill/Connector/Workflow không thuộc Plugin. Mọi thành phần vào ở trạng thái tắt
- Kích hoạt (`ai.approve`): kiểm tra lại toàn vẹn, chữ ký theo danh sách khóa tin cậy hiện tại, tương thích, phụ thuộc (đã cài, đúng phiên bản, đang bật), thành phần còn đủ, Secret Vault đủ khóa cho Connector, bài kiểm tra. Plugin chưa có chữ ký tin cậy chỉ bật được khi người duyệt đánh dấu chấp nhận (ghi audit)
- Tạm dừng, Thu hồi (tắt hẳn, chỉ còn gỡ được), Gỡ (xóa cả thành phần; bị chặn khi Plugin khác phụ thuộc), Cập nhật (cài đè bản mới, thành phần bị bỏ trong bản mới bị xóa), Quay về phiên bản cũ, Xuất tệp
- Nhà phát hành tin cậy: thêm khóa công khai Ed25519 (hiện vân tay để so), thôi tin cậy thì các Plugin đang bật do khóa đó ký bị tạm dừng
- Extension SDK `packages/sdk` (`@maris/sdk`): `definePlugin`, `signPlugin`, `verifyPluginSignature`, `checkPlugin`, `generatePublisherKeys` và lệnh `pnpm ext keygen|pack|sign|verify|check`. Hướng dẫn ở `docs/EXTENSION_SDK.md`
- Trang `/plugins` (mục M34): Plugin mẫu “Chăm sóc đánh giá khách hàng”, cài từ tệp, chi tiết quyền, thành phần, kết quả kiểm tra, phiên bản; quản lý nhà phát hành tin cậy
- Giới hạn: Plugin chưa chứa được Agent hay mã chạy (chờ sandbox Giai đoạn 5); chưa có kho Plugin chung và tự cập nhật; bài kiểm tra chỉ chạy thử, không gọi dịch vụ thật


`12/05/2026`

# Legacy Note

This document is historical planning context. The current production direction is
the lean internal automation agent described in `docs/technical/BUSINESS_RULES.md`:
Telegram long polling, Playwright automation, local JSON settings, local case
memory, local screenshots, Telegram settings commands, and an in-memory
automation lock.

Do not use the Redis, BullMQ, large dashboard, PostgreSQL, cloud screenshot
storage, public webhook server, or full production deployment sections as current
implementation scope unless the project direction changes again.


# Telegram Agent Technical Debt Plan

## 1. Mục đích tài liệu

Tài liệu này ghi lại quyết định kỹ thuật tạm thời khi xây dựng Telegram Agent cho MVP.

Ở giai đoạn hiện tại, hệ thống sẽ sử dụng Telegram Bot bằng **local long polling** để nhận tin nhắn từ nhân viên/operator. Cách này giúp kiểm thử nhanh luồng:

Telegram request → AI Parser → 1Booking Browser Automation → Screenshot → Telegram response.

Tuy nhiên, long polling không phải kiến trúc production cuối cùng. Đây là một technical debt có chủ đích, được chấp nhận để giảm thời gian build MVP ban đầu.

---

## 2. Bối cảnh hiện tại

Hệ thống đã hoàn tất mô phỏng Browser Automation với Playwright:

- Đăng nhập 1Booking bằng storage state.
- Search chuyến bay.
- Đợi UI render ổn định.
- Assert có ít nhất 1 kết quả chuyến bay.
- Screenshot danh sách chuyến bay.
- Tách helper theo separation of concerns.

Bước tiếp theo là tích hợp Telegram Agent để nhân viên có thể gửi request tự nhiên vào bot, sau đó Agent parse request và gọi Playwright search flow.

---

## 3. Quyết định kỹ thuật hiện tại

### Quyết định

Giai đoạn MVP sẽ dùng:

```text
Telegram Bot Local Long Polling
```

Thay vì:

```
Telegram Webhook + Public HTTPS API Server
```

### Lý do chọn Long Polling trước

- Không cần public domain.
- Không cần HTTPS endpoint.
- Không cần deploy server ngay.
- Dễ debug local.
- Dễ kiểm thử nhanh Telegram → Playwright → Telegram.
- Phù hợp với MVP cá nhân/nội bộ.
- Giúp chứng minh core workflow trước khi đầu tư production infrastructure.

---

## 4. Kiến trúc MVP hiện tại

```
[Telegram Bot - Long Polling]
        ↓
[Telegram Message Handler]
        ↓
[Operator Allowlist Check]
        ↓
[AI Parser / Mock Parser]
        ↓
[ParsedFlightRequest Validation]
        ↓
[SearchFlightsInput Mapper]
        ↓
[Playwright 1Booking Search Flow]
        ↓
[Screenshot Result]
        ↓
[Telegram Bot sends photo back]
```

Ở phase đầu, hệ thống có thể dùng mock parser trước để test end-to-end flow. Sau đó mới thay bằng AI parser thật.

---

## 5. Technical Debt được chấp nhận

### TD-001: Dùng Telegram Long Polling thay vì Webhook

### Mô tả

Bot sẽ chạy như một process local hoặc server-side process và liên tục polling Telegram để nhận update.

### Vì sao chấp nhận

Long polling giúp phát triển nhanh, không cần server public, không cần cấu hình HTTPS và phù hợp với giai đoạn proof-of-concept.

### Rủi ro

- Không tối ưu cho production.
- Nếu process chết, bot ngừng nhận tin.
- Khó scale nhiều instance.
- Không phù hợp nếu sau này có nhiều operator hoặc nhiều request đồng thời.
- Khó kiểm soát webhook delivery/retry theo chuẩn production.

### Kế hoạch xử lý sau này

Khi hệ thống đạt MVP ổn định, chuyển sang:

```
Telegram Webhook → NestJS Public API → Queue → Worker
```

---

### TD-002: Chưa dùng Database ở bản Telegram Search v0

### Mô tả

Bản v0 có thể chạy trực tiếp từ Telegram message đến Playwright search mà chưa lưu booking case vào database.

### Vì sao chấp nhận

Giúp chứng minh end-to-end flow nhanh hơn.

### Rủi ro

- Không có lịch sử booking case.
- Không audit được đầy đủ.
- Không khôi phục được case nếu process lỗi.
- Không có trạng thái case rõ ràng.

### Kế hoạch xử lý sau này

Ở bản v1, thêm database:

```
booking_cases
flight_options
screenshots
audit_logs
agent_settings
```

---

### TD-003: Dùng Mock Parser trước AI Parser thật

### Mô tả

Bản đầu tiên có thể dùng parser giả lập trả về route cố định như HAN → SGN để kiểm thử Telegram → Playwright.

### Vì sao chấp nhận

Giúp tách lỗi Telegram/Playwright khỏi lỗi AI parser.

### Rủi ro

- Chưa xử lý request tự nhiên thật.
- Chưa validate đủ case thiếu thông tin.
- Chưa parse ngày/giờ thật.

### Kế hoạch xử lý sau này

Thay mock parser bằng:

```
OpenAI Structured Outputs
+ Zod validation
+ Airport resolver
+ Missing fields handler
```

---

### TD-004: Chưa có Queue trong bản đầu tiên

### Mô tả

Bản Telegram local đầu tiên có thể gọi trực tiếp Playwright search flow trong message handler.

### Vì sao chấp nhận

Dễ build và debug hơn trong giai đoạn local MVP.

### Rủi ro

- Telegram handler bị block khi Playwright chạy lâu.
- Nếu có nhiều request cùng lúc, hệ thống dễ nghẽn.
- Khó retry job.
- Khó theo dõi trạng thái job.

### Kế hoạch xử lý sau này

Chuyển sang:

```
Telegram Handler
→ Create search_flights job
→ BullMQ + Redis
→ Playwright Worker
→ Save result
→ Telegram notify
```

---

### TD-005: Screenshot lưu local trước khi đưa lên Storage

### Mô tả

Bản đầu tiên lưu screenshot vào folder local `screenshots/`.

### Vì sao chấp nhận

Dễ debug và kiểm thử trên máy local.

### Rủi ro

- Không phù hợp production nhiều máy.
- File có thể mất khi deploy lại.
- Khó quản lý retention/cleanup.
- Không phù hợp nếu cần dashboard xem ảnh lâu dài.

### Kế hoạch xử lý sau này

Chuyển sang:

```
Supabase Storage / S3 / Cloudflare R2
```

---

### TD-006: Chưa có Dashboard trong giai đoạn Telegram Search v0

### Mô tả

Telegram Bot là UI chính trong bản đầu tiên.

### Vì sao chấp nhận

Giảm thời gian build frontend, tập trung vào workflow chính.

### Rủi ro

- Khó xem nhiều case.
- Khó filter/search lịch sử.
- Khó quản lý log.
- Khó thao tác settings/toggle.

### Kế hoạch xử lý sau này

Thêm Next.js Dashboard:

```
- Booking case list
- Booking case detail
- Screenshot preview
- Audit logs
- Agent settings
- Job status
```

---

## 6. Production Architecture mong muốn

Khi chuyển sang production, kiến trúc mục tiêu là:

```
[Telegram]
    ↓ webhook
[NestJS API /telegram/webhook]
    ↓
[Telegram Message Handler]
    ↓
[AI Parser Service]
    ↓
[Booking Case Service]
    ↓
[BullMQ + Redis Queue]
    ↓
[Playwright Worker]
    ↓
[1Booking Website]
    ↓
[Storage: Screenshot]
    ↓
[Database: Result / Logs]
    ↓
[Telegram Notification Service]
```

---

## 7. Các bước migration từ MVP sang Production

### Step 1 — Local Long Polling MVP

Mục tiêu:

```
Telegram message
→ mock parser
→ Playwright search
→ screenshot
→ Telegram photo
```

Trạng thái:

```
Local only
No database required
No queue required
No public server required
```

---

### Step 2 — AI Parser thật

Thêm:

```
OpenAI Structured Outputs
Zod schema
Airport resolver
Missing fields response
```

Kết quả:

```
Nhân viên gửi request tự nhiên, Agent parse thành structured data.
```

---

### Step 3 — Database

Thêm:

```
booking_cases
screenshots
audit_logs
agent_settings
```

Kết quả:

```
Mỗi request có caseId, trạng thái và lịch sử xử lý.
```

---

### Step 4 — Queue + Worker

Thêm:

```
BullMQ
Redis
Playwright Worker
Job status
Retry policy
Timeout policy
```

Kết quả:

```
Telegram handler không bị block khi Playwright chạy.
```

---

### Step 5 — Public API + Telegram Webhook

Thêm:

```
NestJS public endpoint
HTTPS domain
Telegram setWebhook
Webhook secret validation
```

Kết quả:

```
Bot sẵn sàng chạy production ổn định hơn.
```

---

### Step 6 — Dashboard

Thêm:

```
Next.js dashboard
Booking case list
Case detail
Screenshot preview
Audit logs
Settings/toggle
```

Kết quả:

```
Dễ vận hành và review nhiều case.
```

---

### Step 7 — Production Hardening

Thêm:

```
Docker
Sentry
Backup
Storage cleanup
Session expired handling
Manual re-login flow
Monitoring
```

Kết quả:

```
Hệ thống đủ ổn định để vận hành nội bộ.
```

---

## 8. Điều kiện để rời khỏi Long Polling

Long polling nên được thay bằng webhook khi có ít nhất một trong các điều kiện sau:

```
- Bot cần chạy ổn định 24/7.
- Có nhiều operator sử dụng.
- Có nhiều request mỗi ngày.
- Cần dashboard realtime.
- Cần deployment production.
- Cần logging/audit đầy đủ.
- Cần queue retry rõ ràng.
```

---

## 9. Điều kiện để thêm Queue

Queue nên được thêm khi:

```
- Playwright search mất hơn 10–15 giây.
- Có nguy cơ nhiều request cùng lúc.
- Cần retry khi search lỗi.
- Cần tracking trạng thái job.
- Cần tách Telegram handler khỏi Browser Automation.
```

---

## 10. Điều kiện để thêm Database

Database nên được thêm khi:

```
- Cần lưu lịch sử request.
- Cần caseId.
- Cần xem lại screenshot.
- Cần audit log.
- Cần match lựa chọn chuyến sau khi khách phản hồi.
- Cần hold booking sau bước search.
```

Vì selection matching và hold booking cần nhớ danh sách chuyến đã search, database sẽ gần như bắt buộc từ MVP v1 trở đi.

---

## 11. Rủi ro chính nếu giữ technical debt quá lâu

Nếu giữ long polling + no database + no queue quá lâu, hệ thống sẽ gặp các vấn đề:

```
- Khó debug case cũ.
- Không biết request nào đã xử lý đến đâu.
- Dễ mất dữ liệu khi process restart.
- Telegram handler bị block khi Playwright chạy lâu.
- Không scale được nhiều operator.
- Khó chuyển sang Auto Mode.
```

Vì vậy technical debt này chỉ nên tồn tại trong giai đoạn local MVP/prototype.

---

## 12. Quy tắc phát triển từ bây giờ

Tất cả code mới nên tuân thủ:

```
1. Tách function theo trách nhiệm rõ ràng.
2. Có comment mô tả chức năng chính của helper/function.
3. Không để codegen raw trong business flow.
4. Không truyền raw AI output trực tiếp vào Playwright.
5. Luôn validate data trước khi automation.
6. Luôn có error screenshot khi Playwright fail.
7. Không hardcode route trong production flow.
8. Tất cả automation phải dùng viewport thống nhất.
9. Long polling chỉ dùng cho local MVP.
10. Sau này chuyển sang webhook không được viết lại business logic, chỉ đổi transport layer.
```

---

## 13. Acceptance Criteria cho Telegram Local Long Polling MVP

Giai đoạn tiếp theo được xem là hoàn thành khi:

```
1. Telegram Bot chạy được ở local bằng long polling.
2. Bot chỉ cho phép Telegram user ID nằm trong allowlist.
3. Nhân viên gửi text request vào bot.
4. Bot parse request bằng mock parser.
5. Bot map parsed data sang SearchFlightsInput.
6. Bot gọi Playwright searchFlights().
7. Playwright search thành công trên 1Booking.
8. Screenshot danh sách chuyến bay được gửi ngược lại Telegram.
9. Nếu automation lỗi, bot gửi message lỗi và screenshot lỗi.
10. Logic được tách thành service/helper rõ ràng để sau này chuyển sang webhook.
```

---

## 14. Kết luận

Việc dùng Telegram Bot local long polling là lựa chọn hợp lý cho giai đoạn MVP hiện tại.

Đây là technical debt có kiểm soát, vì nó giúp chứng minh core workflow nhanh:

```
Telegram → Agent → Playwright → Screenshot → Telegram
```

Tuy nhiên, để tiến tới production, hệ thống cần được nâng cấp dần sang:

```
Webhook API
Database
Queue + Worker
Cloud Storage
Dashboard
Monitoring
Production deployment
```

Sau khi Telegram Local Long Polling MVP chạy ổn, bước tiếp theo sẽ là tích hợp AI parser thật và lưu booking case vào database.

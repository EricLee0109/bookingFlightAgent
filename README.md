# Dự Án AI Agent Đặt Vé Máy Bay (MVP)

## Mục tiêu dự án
Dự án xây dựng một hệ thống AI Agent hỗ trợ nhân viên nội bộ xử lý yêu cầu đặt vé máy bay từ khách hàng. MVP tập trung vào **giảm thiểu thao tác thủ công**, giúp:

- Nhân viên nhận yêu cầu khách từ Zalo.
- Agent phân tích thông tin chuyến bay.
- Agent thực hiện tìm chuyến trên 1Booking bằng Browser Automation (Playwright).
- Kết quả được gửi về Telegram cho nhân viên, nhân viên gửi lại cho khách trên Zalo.
- Lưu log và screenshot để theo dõi trạng thái nghiệp vụ.

> Lưu ý: MVP chưa tích hợp Zalo OA và chưa tự động gửi tin nhắn trực tiếp cho khách. Đây sẽ là phase sau khi test xong OA.

---

## ASCII Flow — Luồng nghiệp vụ MVP (Cải thiện)

+-------------------+
| KHÁCH HÀNG        |
+-------------------+
          |
          v
+-------------------+
| Zalo cá nhân       |  <- Khách nhắn, nhân viên copy/forward
+-------------------+
          |
          v
+-------------------+
| Nhân viên          |  <- Kiểm tra và gửi yêu cầu vào Telegram Agent
+-------------------+
          |
          v
+-------------------+
| Telegram Agent     |
+-------------------+
          |
          |  Tạo booking case & lưu DB
          v
+-------------------+
| Database / Case    |
+-------------------+
          |
          |  Đẩy job vào Queue
          v
+-------------------+
| BullMQ + Redis     |
+-------------------+
          |
          v
+-------------------+
| Playwright Worker  |
| (1Booking search)  |
+-------------------+
          |
          v
+-------------------+
| Screenshot + Flight Options |
+-------------------+
          |
          v
+-------------------+
| Telegram Agent     |
+-------------------+
          |
          v
+-------------------+
| Nhân viên          |  <- Nhận screenshot, gửi lại cho khách trên Zalo
+-------------------+
          |
          v
+-------------------+
| KHÁCH HÀNG chọn chuyến |
+-------------------+
          |
          v
+-------------------+
| Nhân viên nhập lựa chọn vào Telegram |
+-------------------+
          |
          v
+-------------------+
| Agent match chuyến |
+-------------------+
          |
          v
+-------------------+
| BullMQ job: hold booking |
+-------------------+
          |
          v
+-------------------+
| Playwright Worker (chọn chuyến + giữ chỗ) |
+-------------------+
          |
          v
+-------------------+
| PNR code          |
+-------------------+
          |
          v
+-------------------+
| Telegram Agent trả về |
+-------------------+
          |
          v
+-------------------+
| Nhân viên gửi PNR cho khách trên Zalo |
+-------------------+

---

## Tech Stack

**Frontend / UI (MVP)**  
- Next.js + TypeScript  
- Tailwind CSS + shadcn/ui  
- Telegram Bot interface (nhận/gửi tin nhắn nội bộ)  

**Backend / API**  
- NestJS + TypeScript  
- PostgreSQL hoặc Supabase (lưu booking case, log, screenshot URL)  
- Prisma ORM  
- OpenAI Structured Outputs + Zod (parse tin nhắn khách)  

**Automation**  
- Playwright (Browser Automation trên 1Booking)  
- BullMQ + Redis (queue jobs background)  
- Supabase Storage hoặc S3 (lưu screenshot)  

**Ops / Monitoring**  
- Docker (chạy Playwright Worker)  
- Sentry (bắt lỗi)  
- Audit logs cơ bản trong database  

> Lưu ý: RBAC không cần cho MVP vì chỉ có một hoặc vài operator nội bộ.

---

## Viewport Policy (Rất quan trọng - Nhất quán layout để playwright có thể chạy ổn)

1Booking là web app responsive, nên automation có thể fail nếu viewport thay đổi.

Toàn bộ Playwright flows phải chạy với viewport cố định:

- width: 1440
- height: 900
- deviceScaleFactor: 1

Các flow codegen, save-auth, search-flights, screenshot và hold-booking phải dùng cùng viewport này.

Không dùng viewport mặc định hoặc viewport phụ thuộc kích thước màn hình thật trong production.

---

## Cấu trúc folder gợi ý

/apps
/web # Next.js dashboard (tùy chọn)
/worker # Playwright automation worker
/api # NestJS backend
/packages
/shared # Types, Zod schema, constants
/ui # Shared UI components (nếu có)
/config # tsconfig, eslint, prettier
/auth # Session/Storage state Playwright


---

## Cách chạy MVP (local dev)

1. Clone repo:

```bash
git clone <repo-url>
cd <project>
Cài dependencies:
npm install
# or pnpm install

---

Chạy backend API:
npm run start:api

---

Chạy Playwright Worker:
npm run start:worker

---

Chạy Telegram Bot (nhận request từ nhân viên):
npm run start:telegram

---

Test Playwright với site demo / 1Booking (cần session login):
pnpm run save-auth:dev
pnpm exec tsx scripts/test-1booking-auth.ts

```

### Khởi tạo Linux / WSL / VMware mới

Trong `.env`, giữ `PLAYWRIGHT_HEADLESS=true` và khai báo đầy đủ
`ONE_BOOKING_AGENT_ID`, `ONE_BOOKING_USERNAME`, `ONE_BOOKING_PASSWORD`.

Sau mỗi lần clone mới, chạy một lần để tạo auth-state:

```bash
pnpm run save-auth:dev
```

Lệnh này đăng nhập tự động bằng credentials trong `.env`, không yêu cầu nhập tay,
tự tạo thư mục `auth/` nếu chưa có và lưu đúng file
`auth/1booking-storage-state.json`. Thư mục `auth/` nằm trong `.gitignore`, vì vậy
mỗi Linux/VMware clone phải tự tạo lại auth-state.

Sau đó khởi động Telegram agent:

```bash
pnpm run telegram:dev
```

Không đặt file ở root với tên `1booking-session-storage.json`, vì agent chỉ đọc
đúng đường dẫn `auth/1booking-storage-state.json`.

---

## Cấu hình Playwright headless

Playwright mặc định chạy headless để phù hợp với WSL, VMware, VPS và cloud. Có
thể đổi nhanh chế độ chạy trong `.env`:

```env
PLAYWRIGHT_HEADLESS=true
```

- Không khai báo biến hoặc đặt `true`: chạy headless.
- Đặt `false`: mở cửa sổ browser để debug ở máy local.
- Với `PLAYWRIGHT_HEADLESS=true`, chạy `pnpm run save-auth:dev` để
  đăng nhập tự động từ `.env`; không cần thao tác trong Chromium.
- Chỉ dùng `pnpm run save-auth:dev -- --manual` trên máy có giao diện đồ
  họa và đặt `PLAYWRIGHT_HEADLESS=false`, vì chế độ này yêu cầu đăng nhập trong
  cửa sổ Chromium rồi nhấn Enter ở terminal.

---

Phần mở rộng (Phase sau MVP)
Tích hợp Zalo OA để Agent gửi screenshot/lịch trình trực tiếp cho khách.
Auto Mode: Agent tự search, match, hold mà không cần nhân viên bấm tay (có toggle bật/tắt).
Dashboard đầy đủ cho quản lý booking case, trạng thái, audit logs.
Multi-operator và RBAC nếu công ty cần nhiều người quản lý Agent.
Realtime notifications, analytics, báo cáo.
Vector DB / RAG nếu muốn Agent học rules nghiệp vụ hoặc FAQ hãng bay.

---

Ghi chú quan trọng
MVP chỉ dùng Telegram làm kênh nội bộ.
Zalo cá nhân vẫn giữ cho khách cũ, Agent không auto gửi cho khách trong MVP.
1Booking không có public API, Playwright là cách duy nhất để automation trong MVP.
Session/state Playwright lưu auth-state sau login để tránh đăng nhập lại nhiều lần. Chạy `pnpm run save-auth:dev` để tạo hoặc làm mới auth-state.

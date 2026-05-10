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

## ASCII Flow — Luồng nghiệp vụ MVP

KHÁCH HÀNG
|
v
[Zalo cá nhân]
| (copy/forward)
v
[Nhân viên]
|
v
[Telegram Agent] --------+
| |
| Tạo booking case|
v |
[Database] |
| |
v |
[BullMQ + Redis Queue] |
| |
v |
[Playwright Worker] |
| |
v |
[1Booking Dashboard] |
| |
v |
[Screenshot + Flight Options]
|
v
[Telegram Agent] <----+
| |
v |
[Nhân viên] |
| |
v |
[Zalo cá nhân] --------+
|
v
KHÁCH HÀNG chọn chuyến
|
v
[Nhân viên gửi lựa chọn vào Telegram]
|
v
[Agent match chuyến]
|
v
[BullMQ job: hold booking]
|
v
[Playwright Worker chọn chuyến + giữ chỗ]
|
v
[PNR code]
|
v
[Telegram Agent trả về]
|
v
[Nhân viên gửi PNR cho khách trên Zalo]


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
# hoặc pnpm install
Chạy backend API:
npm run start:api
Chạy Playwright Worker:
npm run start:worker
Chạy Telegram Bot (nhận request từ nhân viên):
npm run start:telegram
Test Playwright với site demo / 1Booking (cần session login):
npx tsx scripts/save-auth.ts
npx tsx scripts/test-1booking-auth.ts
Phần mở rộng (Phase sau MVP)
Tích hợp Zalo OA để Agent gửi screenshot/lịch trình trực tiếp cho khách.
Auto Mode: Agent tự search, match, hold mà không cần nhân viên bấm tay (có toggle bật/tắt).
Dashboard đầy đủ cho quản lý booking case, trạng thái, audit logs.
Multi-operator và RBAC nếu công ty cần nhiều người quản lý Agent.
Realtime notifications, analytics, báo cáo.
Vector DB / RAG nếu muốn Agent học rules nghiệp vụ hoặc FAQ hãng bay.
Ghi chú quan trọng
MVP chỉ dùng Telegram làm kênh nội bộ.
Zalo cá nhân vẫn giữ cho khách cũ, Agent không auto gửi cho khách trong MVP.
1Booking không có public API, Playwright là cách duy nhất để automation trong MVP.
Session/state Playwright nên lưu sau login thủ công để tránh login lại nhiều lần.

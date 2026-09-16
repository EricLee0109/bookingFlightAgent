# Kết nối 9Router

Ứng dụng vẫn dùng OpenAI Agents SDK để điều phối các tool. Provider quyết định endpoint, API key và model dùng cho mỗi yêu cầu AI. Đổi provider không mở thêm quyền chọn chuyến, xử lý hành khách hoặc giữ chỗ trong pilot `hybrid_search`.

## Cấu hình local

Lưu các biến sau trong `.env` tại thư mục gốc dự án:

```dotenv
AI_API_PROVIDER=9router
NINE_ROUTER_BASE_URL=http://localhost:20128/v1
NINE_ROUTER_API_KEY=<key riêng tạo trong 9Router>
NINE_ROUTER_MODEL=cx/gpt-5.6-luna
NINE_ROUTER_API=chat_completions
HYBRID_SEARCH_MODEL_TIMEOUT_MS=30000
AGENT_ORCHESTRATION_MODE=hybrid_search
```

Không commit API key. Khi chọn 9Router, ứng dụng chỉ dùng `NINE_ROUTER_API_KEY`; thiếu key hoặc model là lỗi cấu hình, không tự chuyển sang OpenAI trực tiếp. `OPENAI_API_KEY` và `OPENAI_MODEL` được giữ riêng để có thể đổi lại `AI_API_PROVIDER=openai`.

`NINE_ROUTER_MODEL` phải khớp ID mà endpoint `/v1/models` trả về. Trên máy đã kiểm tra ngày 14/09/2026, ID Luna là `cx/gpt-5.6-luna`. API key trong trang 9Router được dùng để xác thực với proxy local; model phía sau vẫn phụ thuộc cấu hình provider của 9Router.

`HYBRID_SEARCH_MODEL_TIMEOUT_MS` giới hạn thời gian mỗi lượt gọi model của pilot; mặc định 15.000 ms. Cấu hình local dùng 30.000 ms vì đã quan sát một lượt qua proxy vượt giới hạn 15 giây.

Sau khi đổi `.env`, dừng tiến trình Telegram cũ rồi khởi động lại bằng `pnpm run telegram:dev`. `pnpm build` tạo bản dùng với `pnpm run telegram:start`.

## Kiểm tra

- `pnpm run test:ai-provider` kiểm tra chọn provider, tách key, endpoint và transport SDK bằng HTTP giả lập; không gọi API thật. Chạy thêm các suite SDK, Telegram và parser khi thay đổi tích hợp.
- `pnpm run eval:hybrid-search` gọi provider thật với hội thoại kiểm thử và automation giả lập. Script không gửi Telegram hoặc đặt giữ chỗ.
- HTTP 401/403: kiểm tra key và trạng thái key trong 9Router. HTTP 429: provider phía sau proxy đang giới hạn; đổi endpoint không tự bảo đảm hết giới hạn.

## Kết quả kiểm tra ngày 14/09/2026

- Key local đã xác thực thành công với `http://localhost:20128/v1`, model `cx/gpt-5.6-luna`.
- Parser chuyến bay trả JSON hợp schema qua Chat Completions. Agents SDK gọi function tool thành công qua cùng provider.
- Evaluator đủ tám lượt model và một lượt replay đã qua: hỏi rõ giờ → tìm → lọc snapshot → làm mới → từ chối giữ chỗ; ngày thiếu năm tiếp tục đúng 30/07/2027 và “17h” áp dụng cửa sổ 15:00–19:00. Automation dùng 40 chuyến giả lập, state tách riêng; không gửi Telegram hoặc đặt vé.
- Kiểm tra SDK riêng trên snapshot 56 chuyến đã ghi nhận từ 1Booking cũng qua: tìm từ 08:00 trả 44 chuyến; lọc sau 10:00 còn 38 chuyến, vẫn một lần gọi adapter.
- Đã sửa lỗi bỏ qua timeout tùy chọn khi model là tên chuỗi. Cấu hình local đặt 30 giây; lần chạy lại evaluator hoàn tất không gặp 429.
- Các suite provider, parser, SDK/session, hợp đồng tìm chuyến, Telegram và production build đã qua. Luồng gửi/nhận Telegram thực tế cần test sau khi khởi động lại bot.

## Bài học sau review

- Đổi key phải đi cùng endpoint, model ID và transport; dùng một cấu hình chung giúp parser và SDK không vô tình gọi hai provider khác nhau.
- Test hàm đọc timeout chưa đủ: cần chạy nhánh SDK dùng tên model thật với HTTP giả lập chậm để chứng minh timeout được áp dụng.
- Phân biệt rõ kiểm thử model thật, dữ liệu browser giả lập, snapshot đã ghi và Telegram thực tế khi báo cáo kết quả.

## Nguồn đối chiếu

9Router hướng dẫn dùng OpenAI SDK với `baseURL` local và API key tạo trong dashboard: [9Router integration](https://github.com/decolua/9router/blob/master/gitbook/content/en/integration/other-tools.md). OpenAI mô tả việc lựa chọn model/provider cho Agents SDK tại [Models and providers](https://developers.openai.com/api/docs/guides/agents/models). Code tích hợp được kiểm tra thêm với phiên bản SDK đang cài trong dự án.

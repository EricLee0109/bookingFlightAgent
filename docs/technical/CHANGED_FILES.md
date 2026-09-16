# Các file đang thay đổi

Cập nhật: 2026-09-16 (Asia/Saigon). Tổng cộng 20 file trong working tree.

Checkout sạch khi bắt đầu đợt customer UX này; các đợt trước đã nằm trong lịch sử Git. Inventory hiện tại là thay đổi của đợt này; nhật ký cũ được giữ để truy vết.

`M` = file đã theo dõi có thay đổi. `??` = file mới, chưa được Git theo dõi; `git diff` thông thường không hiển thị nội dung của nhóm này. Bấm tên file để mở nội dung. Chưa commit hoặc push.

`.env` là cấu hình local bị Git bỏ qua, nên không xuất hiện trong diff. Không đưa API key vào báo cáo này.

Để xem thay đổi các file đã theo dõi: `git diff`. Để xem cả file mới: `git status --short`.

## Quy tắc cập nhật

Sau mỗi đợt thay đổi, cập nhật nhật ký bên dưới cùng danh sách Git: ngày, yêu cầu, từng file, thay đổi cụ thể, kiểm chứng và phần chưa kiểm chứng. Giữ các mục cũ để truy vết; không coi toàn bộ working tree là thay đổi của đợt mới nhất. Không ghi secrets hoặc API key.

## Nhật ký thay đổi gần đây

### 2026-09-16 — Chốt hành khách từ đủ 18 tuổi vào ngày bay

**Quyết định của chủ dự án:** hành khách phải từ 18 tuổi trở lên. Áp dụng đủ 18 vào ngày khởi hành; đúng sinh nhật 18 được xác nhận, trước sinh nhật một ngày bị chặn. Quyết định này thay thế trạng thái chờ chốt 12/18 trong nhật ký bên dưới.

| File | Thay đổi trong lượt này |
| --- | --- |
| `src/services/hybrid-customer-passenger-service.ts` | Mặc định 18; chỉ chấp nhận cấu hình 18, không cho giá trị 12 hạ giới hạn; thông báo riêng cho cấu hình không hợp lệ. |
| `.env` (local, Git ignored) | Đặt duy nhất HYBRID_PASSENGER_MINIMUM_AGE=18; không thay provider, model hoặc credentials. |
| `.env.example` | Giá trị 18 và hướng dẫn mặc định/ràng buộc. |
| `tests/test-hybrid-customer-flow.ts` | Kiểm tra sinh nhật 18 và trước một ngày; cấu hình 12/NaN không cho xác nhận. |
| `docs/technical/BUSINESS_RULES.md` | Chuyển từ quyết định đang chờ sang quy tắc được phê duyệt. |
| `docs/technical/CHANGED_FILES.md` | Ghi quyết định, phạm vi và kiểm chứng. |

**Kiểm chứng:** test:hybrid-customer-flow và production build qua; diff/new-file whitespace check qua. Không chạy Telegram/provider/1Booking thật. Cần restart bot để nạp code và cấu hình mới; draft cũ được giữ. Chưa mở form hoặc giữ chỗ. Inventory vẫn 20 file Git của cả đợt UX, cộng .env local bị bỏ qua.


### 2026-09-16 — Sửa vòng lặp ngày sinh khách mới

**Nguyên nhân đã tái hiện bằng model giả:** tool cho phép chuỗi DOB nhưng validator chỉ nhận YYYY-MM-DD. Với tin nhắn 07/09/2002 và proposal cùng định dạng, parser trả patch rỗng/invalidFields dob. ISO của cùng ngày lại được chấp nhận. Prompt cũ không chỉ rõ format output; test cũ đều trả ISO nên bỏ sót mismatch. Không có raw response provider thật để khẳng định chính xác proposal của lượt trong ảnh.

| File | Thay đổi trong lượt này |
| --- | --- |
| [src/agent/hybrid-passenger-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-passenger-agent.ts>) | Nêu rõ DOB ISO trong tool schema/prompt; chuẩn hóa dạng ngày Việt Nam trước khi kiểm tra calendar, future và đối chiếu một ngày duy nhất từ tin nhắn. |
| [tests/test-hybrid-passenger-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-passenger-agent.ts>) | Tái hiện fail trước sửa khi model trả 07/09/2002; hồi quy ISO, DD/MM, dấu chấm/gạch, số 0, ngày bằng chữ, leap day, đảo ngày/tháng và ngày mâu thuẫn. |
| [tests/test-hybrid-customer-flow.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-customer-flow.ts>) | DOB đã bị từ chối → restart → nhập lại dạng Việt Nam: giữ tên/giới tính, xóa unresolved DOB, lưu ISO; tách missing-age gate và xác nhận với ngưỡng test rõ ràng. |
| [docs/technical/BUSINESS_RULES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/BUSINESS_RULES.md>) | Quy tắc DOB canonical và phân biệt lỗi ngày với thiếu chính sách tuổi. |
| [docs/technical/CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Ghi nguyên nhân tái hiện, 5 file sửa trong lượt này và bằng chứng kiểm thử. |

**Hành vi sau sửa:** model có thể trả ngày dạng ISO hoặc DD/MM/YYYY tương đương; code luôn lưu YYYY-MM-DD sau kiểm tra. Không đoán năm thiếu, không đảo DD/MM, không chọn một trong nhiều ngày và không lấy DOB cũ làm căn cứ cho edit mới. DOB sai lịch, tương lai, không có trong tin nhắn hoặc mâu thuẫn vẫn bị chặn.

**Hai vấn đề tách biệt:** .env local chưa có ngưỡng tuổi được hỗ trợ. Fix này không đặt ngưỡng tuổi và không sửa .env. Khi thiếu chính sách, DOB hợp lệ vẫn được lưu và không còn nằm trong pending/unresolved; xác nhận tiếp tục bị chặn theo business gate đã ghi ở đợt trước.

**Bằng chứng:** regression mới thất bại trước sửa (patch {} thay vì DOB ISO) và qua sau sửa. test:hybrid-passenger-agent, test:hybrid-customer-flow, test:passenger-parser, test:customer-passengers, test:passengers, test:hybrid-search-telegram và waiting-feedback đều qua; pnpm build và diff/new-file whitespace check qua. Model/DB/Telegram dùng giả lập hoặc dữ liệu tạm; chưa chạy provider/Telegram/1Booking thật. Không thay model/provider, danh bạ, luồng legacy hay hold. Sau restart bot, nhập lại DOB để phục hồi draft đang chờ; không cần xóa dữ liệu.


### 2026-09-16 — Chọn chuyến và xác nhận khách cá nhân trong hybrid

**Phạm vi:** chat riêng, một hành khách; chọn chuyến từ snapshot → nhập hoặc chọn khách đã lưu → kiểm tra họ/tên, giới tính, DOB → xác nhận thông tin. Không mở form 1Booking, không tạo holdApproval, không giữ chỗ. Provider/model và legacy giữ nguyên. Danh bạ thuộc Telegram user, không tự ghép với passenger_profiles dùng chung.

| File | Thay đổi |
| --- | --- |
| [.env.example](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/.env.example>) | Khai báo ngưỡng tuổi chưa có mặc định; thiếu cấu hình sẽ chặn xác nhận. Cập nhật mô tả hybrid; không sửa .env thật. |
| [docs/technical/BUSINESS_RULES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/BUSINESS_RULES.md>) | Quy tắc danh bạ riêng, consent, bản sao case, trạng thái không hold và chính sách tuổi đang chờ chốt. |
| [docs/technical/CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Nhật ký triển khai, bằng chứng kiểm thử, giới hạn và inventory Git hiện tại. |
| [docs/technical/HYBRID_AGENT_ARCHITECTURE.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/HYBRID_AGENT_ARCHITECTURE.md>) | Ghi phạm vi customer flow mới tách khỏi search tools và hold legacy. |
| [package.json](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/package.json>) | Thêm ba lệnh kiểm thử customer store, passenger interpreter và customer flow. |
| [src/agent/hybrid-passenger-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-passenger-agent.ts>) | SDK chỉ đề xuất dữ liệu có căn cứ trong tin hiện tại; giới hạn một lượt, kiểm tra tên/giới tính/DOB, lookup riêng và lỗi an toàn. |
| [src/agent/hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Sinh nút chọn theo ID từng trang; vô hiệu xác nhận khách khi search thay đổi. |
| [src/passengers/customer-passenger-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/passengers/customer-passenger-store.ts>) | Bảng SQLite riêng; owner-scoped read/list/create/update, phân trang, idempotency và optimistic version. |
| [src/passengers/customer-passenger-types.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/passengers/customer-passenger-types.ts>) | Hợp đồng hồ sơ khách cá nhân tách khỏi dữ liệu legacy. |
| [src/passengers/hybrid-passenger-state.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/passengers/hybrid-passenger-state.ts>) | Schema draft/trường chờ/revision/xác nhận; binding case/snapshot/candidate và dấu vân tay yêu cầu. |
| [src/services/hybrid-customer-passenger-service.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/services/hybrid-customer-passenger-service.ts>) | State machine chọn chuyến, nhập/chọn khách, xác nhận, opt-in lưu và preview cập nhật; không gọi hold. |
| [src/services/hybrid-customer-selection.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/services/hybrid-customer-selection.ts>) | Kiểm tra nguồn chuyến, tuyến/ngày, bộ lọc, freshness và vô hiệu xác nhận khi yêu cầu thay đổi. |
| [src/storage/hybrid-search-session-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/storage/hybrid-search-session-store.ts>) | Con trỏ passengerCaseId tùy chọn, tương thích session cũ. |
| [src/storage/local-case-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/storage/local-case-store.ts>) | Lưu flow/bản sao xác nhận theo case và hai trạng thái hybrid riêng. |
| [src/telegram/telegram-hybrid-search.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-hybrid-search.ts>) | Routing customer chat/callback, nút chọn dưới ảnh, một thông báo chờ dùng chung và cập nhật help. |
| [src/telegram/telegram-passenger-message-handler.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-passenger-message-handler.ts>) | Cho phép callback customer mới trong hybrid; giữ chặn callback hold legacy. |
| [tests/test-customer-passenger-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-customer-passenger-store.ts>) | SQLite tạm: owner isolation, trùng tên, phân trang, consent idempotency, version và migration không đổi legacy. |
| [tests/test-hybrid-customer-flow.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-customer-flow.ts>) | Case/session/DB tạm: nhiều lượt, SDK giả, restart, sửa/cancel/consent, nút cũ, no-hold và thiếu chính sách tuổi. |
| [tests/test-hybrid-passenger-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-passenger-agent.ts>) | Model SDK giả: literal evidence, DOB mâu thuẫn, tên trùng từ giới tính, browse và timeout/429 không retry. |
| [tests/test-hybrid-search-pagination.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-pagination.ts>) | Kiểm tra nút chọn trên 57 chuyến/12 trang, đúng ảnh; subprocess đóng worker trước cleanup để tránh EBUSY trên Windows. |

**Trạng thái nghiệp vụ còn chờ:** cần chủ dự án chọn ngưỡng tuổi 12 hay 18 tính vào ngày bay. HYBRID_PASSENGER_MINIMUM_AGE chưa được đặt trong môi trường thật. Thiếu/không hợp lệ sẽ giữ draft và chặn xác nhận; không âm thầm bỏ kiểm tra tuổi. Fixture test dùng 18 không phải quyết định production.

**Kiểm chứng tự động:** ba suite mới (test:customer-passengers, test:hybrid-passenger-agent, test:hybrid-customer-flow) qua. Các suite hybrid search contract/agent/reliability/intent/Telegram/pagination, airports (193 aliases), parser và passengers legacy, passenger-parser và waiting-feedback qua. Ba test screenshot Chromium dùng HTML local qua. Production build TypeScript và kiểm tra diff/whitespace qua. Kiểm thử dùng SDK model/Telegram/browser giả lập và SQLite/case/session tạm; không dùng API key, danh bạ thật hoặc thao tác booking thật.

**Review:** sub-agent Luna MAX triển khai store/interpreter; manager review và sửa integration/validation, reviewer độc lập kiểm tra lại ownership, stale buttons và no-hold. Đã sửa lệch trang 0/1 và so sánh candidate phụ thuộc thứ tự key JSON. Đã thêm regression tên Nam/Nữ/Bé và DOB bị từ chối không được tái chấp nhận nhờ một edit không liên quan.

**Chưa kiểm chứng:** Telegram/9Router/1Booking thật. Bot đang chạy cần restart để nhận code mới; tin Telegram cũ không tự có nút chọn, cần xem/tìm lại kết quả. Allowlist Telegram hiện có vẫn áp dụng; chưa mở đăng ký tài khoản công khai. Chưa thể coi cấu hình production hoàn tất khi chưa chốt ngưỡng tuổi.


### 2026-09-16 — Xem đầy đủ danh sách chuyến bằng phân trang Telegram

**Nguyên nhân:** filter giữ đủ snapshot nhưng selectedCandidates mặc định chỉ có 5 chuyến; Telegram chưa có điều khiển phân trang. Vì vậy tiêu đề báo 57 chuyến nhưng khách chỉ xem được 5 chuyến đầu. Không phải browser chỉ lưu được 5 chuyến.

| File | Thay đổi trong đợt này |
| --- | --- |
| [flight-search-snapshot.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/automation/1booking/flight-search-snapshot.ts>) | Phân trang sau khi lọc/xếp hạng toàn bộ snapshot; kiểm tra offset và giữ danh sách ID theo đúng thứ tự. |
| [hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Ghi rõ số chuyến đang hiển thị/tổng số; tạo cursor cho danh sách hiện tại; đọc trang bằng code, kiểm tra snapshot, tuyến/ngày, bộ lọc, pending clarification và replay; không gọi model/browser. |
| [hybrid-search-session-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/storage/hybrid-search-session-store.ts>) | resultView tùy chọn có schema, giữ cursor và các ID qua restart; tương thích session cũ. |
| [telegram-hybrid-search.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-hybrid-search.ts>) | Nút Trang trước/Trang sau đặt dưới ảnh; mỗi trang tối đa 5 chuyến và chỉ gửi ảnh tương ứng; cập nhật /help. |
| [telegram-passenger-message-handler.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-passenger-message-handler.ts>) | Cho phép riêng callback xem trang sau allowlist/ack trong hybrid; tiếp tục chặn mọi callback chọn khách/giữ chỗ/PNR. |
| [test-hybrid-search-pagination.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-pagination.ts>) | Mới: 57 chuyến/12 trang, trang cuối 2 chuyến, ảnh đúng ID/thứ tự, restart, duplicate callback, invalid/stale cursor, đổi bộ lọc, ranking và transport thật với FakeBot. |
| [package.json](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/package.json>) | Thêm test:hybrid-search-pagination. |
| [BUSINESS_RULES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/BUSINESS_RULES.md>) | Quy tắc phân trang, snapshot đã lưu, vô hiệu hoá nút cũ và phạm vi kiểm chứng. |
| [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Nhật ký 9 file đợt phân trang và bổ sung file test vào inventory. |

**Hành vi:** hiển thị “Đang hiển thị chuyến 1–5/57”, rồi ảnh của 5 chuyến và nút Trang sau. Có thể duyệt 12 trang, trang cuối 56–57/57; Trang trước quay lại cùng thứ tự. Đổi thời gian/hãng/tiêu chí hoặc snapshot tạo danh sách mới và nút cũ không còn dùng được. Cursor chỉ là token giao diện; không thay caseId/snapshotId/candidateId. Kết quả vẫn mang thời điểm quan sát cũ, không có giá mới chỉ vì chuyển trang. Trường hợp xếp giá rẻ thiếu giá có thông báo các chuyến không được xếp hạng.

**Tương thích:** tin Telegram đã gửi trước bản sửa không tự có nút. Sau restart, nhắn “xem lại kết quả” hoặc tìm/lọc chuyến để nhận danh sách có nút. Session cũ không có resultView vẫn đọc được. Ảnh nhóm cũ không đủ chính xác vẫn dùng fallback đã có, không gửi ảnh sai trang.

**Kiểm chứng:** test pagination qua với model/browser/Telegram giả lập; duyệt đủ 57 ID không bỏ sót hoặc lặp, 12 trang đúng ảnh, restart, replay, cross-chat, token/page/ID sai, snapshot sai ngày và bộ lọc/pending thay đổi bị chặn. Các suite hybrid search contract/agent/reliability/intent/Telegram, waiting feedback, airports và parser đều qua. Ba test screenshot bằng Chromium với HTML local, production build và diff/whitespace check cũng qua. Không gọi Telegram, provider hoặc 1Booking thật; chưa xác nhận UX trực tiếp trên Telegram production.

### 2026-09-16 — Sửa vòng lặp xác nhận tìm chuyến mới

**Bằng chứng thực tế:** lúc 13:53, 13:54 và 13:55 (Asia/Saigon), log đều ghi search_flights trả clarification, repairAttempts=1, liveSearchPerformed=false. Lượt đầu/cuối có intent conflict và toAirport unknown; lượt trả lời “tìm chuyến mới” có missing_evidence cho tuyến/ngày. Session sau cùng chỉ còn tripType/missingFields và pending intent/fromAirport/toAirport. Không có bằng chứng timeout, 429 hoặc browser bị treo trong ba lượt này.

**Nguyên nhân tái hiện:** hn chưa có trong catalog; guard intent chặn nhãn model khác với suy luận của code; xác nhận tìm mới tạo draft trống và kiểm tra lại tuyến/ngày chỉ bằng tin nhắn xác nhận, mất dữ kiện hợp lệ của yêu cầu đang chờ. Đã tái hiện bằng input giả lập trước sửa, không sửa/reset session thật.

| File | Thay đổi trong đợt này |
| --- | --- |
| [airport-catalog.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/airport-catalog.ts>) | Thêm alias nguyên token hn → HAN trong catalog dùng chung; hiện có 193 aliases cho 25 sân bay. |
| [hybrid-search-proposal.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-proposal.ts>) | Ý định rõ từ tin nhắn thắng nhãn model sai; câu đủ tuyến có hướng và ngày được nhận là tìm mới. Thêm xác nhận intent bằng draft đã xác minh; giữ trường chưa rõ, chặn câu trả lời mơ hồ và dữ kiện mới không có căn cứ. |
| [hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Lưu riêng các dữ kiện hiện tại đã qua validator khi chờ intent; không ghi đè draft đang dùng trước quyết định. Recovery/prompt thấy dữ kiện chờ. Log resolvedRequestMode/confirmedIntent, không ghi prompt hay dữ liệu mới nhạy cảm. |
| [hybrid-search-session-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/storage/hybrid-search-session-store.ts>) | pendingClarification.intentDraft tùy chọn, dùng schema draft đã có; đọc được session v1 cũ và giữ qua restart. |
| [test-hybrid-search-intent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-intent.ts>) | Mới: SDK/model/browser giả lập cho đúng câu HCM ra HN 10/12, nhãn model sai, session cũ đang kẹt, ambiguous → restart → tìm mới/cập nhật, câu “ừ”, replay, bộ lọc cũ và sửa ngày không có căn cứ. |
| [test-hybrid-search-reliability.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-reliability.ts>) | Điều chỉnh contract: mode rõ từ khách được code xác định thay vì buộc hỏi lại khi model gắn nhãn sai. Giữ các guard dữ liệu khác. |
| [test-airport-resolver.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-airport-resolver.ts>) | Hồi quy hn/HN; toàn bộ aliases, cả legacy/hybrid và prompt vẫn kiểm tra tự động. |
| [package.json](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/package.json>) | Thêm pnpm test:hybrid-search-intent. Không đổi dependency/model/provider. |
| [BUSINESS_RULES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/BUSINESS_RULES.md>) | Ghi quyết định xử lý intent, staged facts, xác nhận tiếp nối, tương thích session cũ và giới hạn kiểm chứng. |
| [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Ghi bằng chứng lỗi thực tế, tái hiện, phạm vi sửa 10 file và inventory 69 file. |

**Sau sửa:** câu “mình muốn tìm chuyến hcm ra hn vào ngày 10/12” resolve SGN → HAN ngày 2026-12-10 trong fixture ngày 2026-09-16; model gắn update_search vẫn được xử lý là tìm mới, không kéo hãng/giờ/giá cũ. Khi intent thực sự chưa rõ, chỉ các dữ kiện của tin nhắn vừa được code xác minh mới được lưu riêng; “tìm chuyến mới” dùng draft đó, “cập nhật yêu cầu hiện tại” ghép với phần cũ không đổi. Câu trả lời mơ hồ không chạy browser. Session cũ đang kẹt có thể phục hồi bằng cách gửi lại câu đủ tuyến/ngày sau restart, không cần xoá dữ liệu.

**Kiểm chứng:** test intent mới, hybrid agent/reliability/contract, test:airports (193 aliases), parser legacy, Telegram adapter/waiting-feedback, production build và diff check. Tất cả model/browser trong regression là giả lập; chỉ đọc log/session thật. Không gọi Telegram/provider/1Booking, không tạo booking. Bộ kiểm thử trước đó chưa bao phủ chuỗi yêu cầu mới → xác nhận ngắn trên session đã có bộ lọc; ca đó đã được bổ sung.

### 2026-09-16 — Ảnh Telegram khớp đúng chuyến sau khi lọc

**Nguyên nhân:** hội thoại đã lọc đúng 8 → 2 chuyến buổi tối. Helper ảnh dùng điều kiện “ảnh nhóm chứa ít nhất một candidate được chọn”, nên vẫn gửi ảnh 8 chuyến. Đây là lỗi chọn ảnh, không phải mất ngữ cảnh hội thoại.

| File | Thay đổi trong đợt này |
| --- | --- |
| [screenshots.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/automation/1booking/screenshots.ts>) | Thêm capture từng card theo cardIndex đã parse; pin DOM element và đối chiếu lại số hiệu, hãng, giờ, hạng và giá trước/sau chụp bằng parser dùng chung. Loại ảnh nếu dữ liệu thay đổi; tên file riêng không ghi đè, giữ pixels gốc. Không đổi helper ảnh nhóm legacy. |
| [flight-search.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/automation/1booking/flight-search.ts>) | Hybrid fullSnapshot chụp từng chuyến và map một path/một candidate; zero-result và legacy giữ hành vi cũ. |
| [flight-search-snapshot.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/automation/1booking/flight-search-snapshot.ts>) | Chỉ trả ảnh khớp toàn bộ IDs được hiển thị và đúng thứ tự. Không gửi ảnh nhóm cũ có chuyến ngoài bộ lọc hoặc ảnh chỉ bao phủ một phần danh sách. |
| [hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Nếu snapshot cũ không có ảnh chính xác, vẫn trả kết quả chữ và hướng dẫn “làm mới kết quả”; không tự chạy lại browser. |
| [telegram-hybrid-search.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-hybrid-search.ts>) | Caption xác nhận ảnh chỉ gồm chuyến trong danh sách đã lọc; 2 chuyến được gửi dưới dạng 2 ảnh riêng. |
| [hybrid-search-screenshots.spec.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/hybrid-search-screenshots.spec.ts>) | Mới: Chromium headless với HTML cục bộ 8 cards; kiểm tra PNG đúng kích thước từng card, buổi tối còn đúng ảnh 19:10/19:50, hãng Vietjet còn một ảnh, thứ tự đảo, restart session, missing/duplicate card, thay số hiệu/giờ/giá phải bị chặn. |
| [test-hybrid-search-contract.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-contract.ts>) | Regression chặn ảnh ghép cũ khi chỉ một candidate trong ảnh phù hợp. |
| [test-hybrid-search-telegram.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-telegram.ts>) | Regression caption chính xác, loại thông báo ảnh có thể chứa chuyến khác. |
| [package.json](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/package.json>) | Thêm pnpm test:hybrid-search-screenshots; không thêm thư viện xử lý ảnh. |
| [BUSINESS_RULES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/BUSINESS_RULES.md>) | Quy tắc ảnh đúng danh sách, nguồn pixels gốc, fallback snapshot cũ và phạm vi kiểm chứng. |
| [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Nhật ký 11 file đợt sửa ảnh; inventory tăng 66 → 68 do screenshots.ts và test mới. |

**Hành vi:** sau một lần tìm mới/làm mới, lưu ảnh thật từng chuyến gắn với candidateId trong snapshotId; thay đổi giờ/hãng chỉ chọn lại ảnh tương ứng, không tạo case hay mở 1Booking lại. Chỉ gửi ảnh của các chuyến thực sự có trong danh sách chữ (tối đa số kết quả đang hiển thị). Giữ bộ ảnh gốc và thời điểm quan sát; không dựng lại nội dung vé hoặc đoán vị trí cắt ảnh cũ.

**Snapshot đã lưu trước bản sửa:** ảnh nhóm cũ không có ranh giới card tin cậy. Nếu không khớp chính xác danh sách hiện tại, bot không gửi ảnh đó và hướng dẫn “làm mới kết quả”. Lệnh này dùng lại tuyến/ngày/bộ lọc đã xác minh để tìm mới và chụp ảnh riêng. Không tự reset session hoặc giả vờ ảnh cũ đã được cắt lại.

**Kiểm chứng:** 3 test Playwright chỉ dùng HTML local qua; đã xem hai PNG đầu ra, mỗi ảnh chỉ chứa card 19:10 hoặc 19:50. Các test hybrid search contract, agent, reliability, Telegram và production build đều qua. Diff check kiểm tra cả tracked và file mới. Chưa gọi Telegram, model/provider hoặc 1Booking thật; test visual local không chứng minh UI live 1Booking hiện tại. Lần capture đầu lưu nhiều file hơn vì mỗi chuyến một ảnh; các lần lọc sau dùng lại ảnh.

### 2026-09-16 — Củng cố độ tin cậy hybrid search theo plan đã duyệt

Phạm vi: tìm và so sánh. Giữ nguyên model/provider hiện tại, parser/service legacy và các ID case/snapshot/candidate. Manager trực tiếp triển khai theo quyền người dùng đã cấp; Luna MAX review độc lập, manager xử lý phản hồi trước kiểm tra cuối.

| File | Thay đổi trong đợt này |
| --- | --- |
| [hybrid-search-proposal.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-proposal.ts>) | Mới: validator theo trường, evidence hiện tại, đối chiếu tất cả catalog matches, vai trò tuyến, intent, pending, ngày/giờ/tiêu chí, xoá có căn cứ và câu hỏi chỉ nêu trường chưa xác minh. |
| [hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Áp dụng validator trước search/compare/clarification; một ngân sách phục hồi, tối đa hai quyết định; bảo toàn clarification nếu lượt sửa lỗi; guard nhiều tool; kiểm tra snapshot, đồng bộ/xoá tiêu chí so sánh ở mọi tool và chẩn đoán đã lọc. |
| [hybrid-flight-request.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-flight-request.ts>) | Tôn trọng năm nay/năm sau; chặn năm rõ ràng mâu thuẫn; giữ quy tắc ngày thiếu năm, timezone, around-time và ngưỡng bay trong ngày. |
| [hybrid-search-session-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/storage/hybrid-search-session-store.ts>) | Session v1 thêm pendingClarification tùy chọn; giữ tương thích session cũ; hạ snapshotFresh khi draft/pending không còn khớp tuyến/ngày. |
| [ai-provider.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/ai-provider.ts>) | Cho phép cấu hình maxRetries theo client; hybrid đặt 0 để 429 không tự retry ở tầng HTTP; giữ default của các caller legacy. |
| [test-hybrid-search-reliability.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-reliability.ts>) | Mới: model/browser giả lập, toàn bộ 192 aliases qua proposal validator, sửa Nha Trang một lần, conflict/missing evidence/intent, ngày/giờ bị bỏ sót, restart/replay, lỗi lượt sửa, nhiều tool, ID/snapshot và bảo toàn bộ lọc. Import runtime sau khi chuyển vào thư mục tạm để cô lập case/session. |
| [test-hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-agent.ts>) | Cập nhật fixtures theo metadata đề xuất; giữ regression SDK/search/cache/clarification/guard và thông báo chờ; tách trạng thái các kịch bản lỗi độc lập. |
| [test-ai-provider.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-ai-provider.ts>) | Giả lập HTTP 429 ở client thật của SDK và xác nhận hybrid chỉ gửi một request; không gọi mạng. |
| [package.json](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/package.json>) | Thêm lệnh pnpm test:hybrid-search-reliability; không đổi dependency, model/provider hoặc lockfile trong đợt này. |
| [BUSINESS_RULES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/BUSINESS_RULES.md>) | Ghi trust boundary, quyết định ngữ cảnh, phục hồi, metadata, định danh, giới hạn pilot và điều kiện kiểm chứng. |
| [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Ghi riêng 11 file của đợt này, evidence kiểm thử và cập nhật inventory 66 file. |

**Quyết định ngữ cảnh:** tìm mới tạo draft mới và không kế thừa hãng/giờ/ưu tiên cũ; cập nhật giữ phần không đổi. Trả lời ngắn chỉ điền trường đang chờ. Nếu intent/vai trò/tên–mã/căn cứ mâu thuẫn, không chạy browser. Giữ phần đã xác minh để hỏi đúng phần thiếu; snapshot cũ còn để audit nhưng không được trình bày như kết quả mới. Candidate ID luôn đi cùng snapshot ID.

**Bằng chứng:** ca HCM → Nha Trang 12/12 Vietjet: model đầu bỏ điểm đến, model sửa trả CXR; hai quyết định, một browser giả lập. Lượt sửa tiếp tục sai hoặc lỗi 429 giữ clarification; không tool hai lần dừng; HTTP 429 thực sự chỉ một fetch giả lập. Toàn bộ aliases qua validator; mã HAN ghép Tân Sơn Nhất, nhiều ngày/giờ, vai trò không rõ, đổi ngày/giờ bị bỏ sót, refresh không có yêu cầu và snapshot sai tuyến/ngày đều có regression. Kiểm tra message trùng/restart và guard nhiều tool. Review cuối phát hiện tiêu chí so sánh cũ ghi đè ranking mới; đã sửa tập trung và test kết quả cached search chuyển sớm nhất → rẻ nhất, xoá ưu tiên, không thêm browser call. Căn cứ giờ/ưu tiên chưa đo được lưu pending để không dùng lại giá trị cũ.

**Kiểm chứng:** pnpm test:hybrid-search-reliability, test:hybrid-search-agent, test:hybrid-search, test:airports, test:ai-provider, test:hybrid-search-telegram, test:parser, test:hybrid-agent; các test Telegram waiting-feedback, bot-errors, file-uploads; production build và diff check đều qua (bao gồm whitespace check cho 33 file untracked). Các cảnh báo gửi acknowledgment thất bại trong waiting-feedback là lỗi được giả lập có chủ đích.

**Giới hạn:** chỉ kiểm thử offline bằng model/HTTP/browser giả lập; chưa kiểm tra Telegram, 9Router hoặc 1Booking thật và chưa đánh giá tỉ lệ hiểu ngôn ngữ thực tế của model. Không mở chọn chuyến, database hành khách hoặc giữ chỗ trong hybrid. Không đổi .env; cần khởi động lại pnpm run telegram:dev để nạp code. Cơ chế bảo toàn dữ liệu hỏi rõ trường chưa hiểu, không cam kết hiểu mọi cách diễn đạt. Đã dọn đúng các case giả của những lần chạy trước khi sửa import-time isolation; không reset session người dùng.

### 2026-09-16 — Mở rộng aliases cho toàn bộ catalog sân bay

Phạm vi theo yêu cầu đã làm rõ: làm phong phú cách gọi trong catalog. Tăng từ **92 lên 192 aliases (+100)** cho **25 sân bay**. Người dùng cho phép manager trực tiếp triển khai sau khi sub-agent Luna chưa trả được kết quả.

| File | Thay đổi trong đợt này |
| --- | --- |
| [airport-catalog.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/airport-catalog.ts>) | Bổ sung tên có dấu và cách viết liền của các địa danh/sân bay đã có; SGN có thêm cách viết TP.HCM và Ho Chi Minh City. Giữ nguyên toàn bộ 25 cặp code/text và 92 aliases cũ. Ghi quy tắc duy trì aliases ngay đầu file. |
| [test-airport-resolver.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-airport-resolver.ts>) | Test toàn bộ aliases: đúng mã/tên, viết hoa/thường, Unicode NFD, không dấu, tên trong cụm “sân bay … nhé”, alias trùng giữa các sân bay, alias chỉ khác hoa/thường, cả điểm đi và điểm đến trong legacy/hybrid. Kiểm tra hai prompt thực sự lấy cùng catalog. Giữ các test hồi quy đ/Đ và short-token trước đó. |
| [package.json](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/package.json>) | Thêm script `pnpm test:airports` để kiểm tra sau mỗi lần bảo trì catalog. Không đổi dependencies hoặc lockfile trong lượt này. |
| [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Ghi phạm vi, ví dụ, kiểm chứng và quy tắc duy trì; cập nhật ngày inventory. |

**Ví dụ trước → sau:** `hochiminh`, `noibai`, `quynhon`, `phucat`, `donghoi`, `dienbien` trước đó đều không resolve; hiện tương ứng SGN, HAN, UIH, UIH, VDH, DIN. Các dạng viết liền như `lienkhuong`, `catbi`, `camranh`, `phuquoc`, `rachgia`, `thoxuan` cũng được kiểm tra.

**Kiểm chứng:** `pnpm test:airports`, hybrid search contract, hybrid search agent, legacy parser contract, hybrid foundation contract, `pnpm build` và `git diff --check` đều qua. Đối chiếu snapshot trước sửa xác nhận không mất mã/tên/alias cũ; resolver và hybrid orchestration không đổi. Không gọi model, Telegram hoặc 1Booking thật trong lượt này; kiểm tra prompt là offline, không phải đánh giá chất lượng câu trả lời của LLM.

**Quy tắc bảo trì:** thêm cách viết rõ nghĩa của sân bay/địa danh đã biết; không tự suy đoán sân bay gần nhất hoặc thêm viết tắt nhập nhằng. Không cần thêm aliases chỉ khác hoa/thường hoặc dạng Unicode. Tên có dấu được giữ rõ trong prompt để model có ngữ cảnh tiếng Việt; normalizer vẫn xử lý bỏ dấu. Chạy `pnpm test:airports` và build sau khi sửa. Khởi động lại bot để nạp catalog mới.

### 2026-09-15 — Chuẩn hóa Đà Nẵng trong resolver dùng chung

| File | Thay đổi |
| --- | --- |
| [airport-resolver.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/airport-resolver.ts>) | Đổi `đ/Đ` thành `d` trước khi bỏ dấu. Trước sửa, “đà nẵng” thành “đa nang”, không khớp alias “da nang”. Dùng chung cho hybrid và legacy. |
| [airport-catalog.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/airport-catalog.ts>) | Thêm alias `dn` cho DAD, giữ quy tắc alias ngắn phải khớp nguyên token. |
| [test-airport-resolver.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-airport-resolver.ts>) | Test hồi quy tên có dấu, viết tắt, catalog và chuẩn hóa điểm đến chỉ có tên trong hybrid/legacy. |
| [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Ghi nguyên nhân, phạm vi kiểm chứng và cập nhật inventory. |

**Tái hiện trước sửa:** request có `toAirportCode=null`, `toAirportText=đà nẵng` trả đúng câu “Bạn cho mình biết điểm đến nhé.”; legacy cũng không tìm được mã với cùng dữ liệu. `dn` chưa có trong catalog.

**Kiểm chứng sau sửa:** đầu vào chỉ có tên Đà Nẵng được chuẩn hóa SGN → DAD ngay trong validator; `đà nẵng`, `Đà Nẵng`, `dn`, `ĐN`, `DAD` đều resolve DAD. Production build, hybrid request contract, hybrid agent và legacy parser tests đã qua. Test hồi quy riêng `tests/test-airport-resolver.ts` cũng đã qua, gồm toàn bộ tên canonical, alias ngắn, Đà Nẵng/Đồng Hới/Điện Biên và parity hybrid/legacy.

**Phân biệt bằng chứng:** log lượt đầu đã gọi `search_flights`, sau đó validator hỏi thiếu điểm đến; không phải SDK buộc hội thoại phải có hai lượt. Log không lưu tham số tool lịch sử, nên chưa khẳng định chính xác model đã gửi tên/mã nào lúc đó. Đây là lỗi resolver được tái hiện độc lập với dữ liệu tương ứng. Không gọi API/Telegram/1Booking thật, không thay đổi session hoặc prompt trong đợt sửa này.


### 2026-09-15 — Điều tra lượt thất bại 13:23 sau thay đổi Telegram

| File | Kết quả kiểm tra / thay đổi |
| --- | --- |
| [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Bổ sung bằng chứng điều tra; lượt này chỉ sửa tài liệu, không sửa runtime hoặc reset dữ liệu. |
| `data/logs/app.log` (chỉ đọc) | 10:58:30 tìm thành công; 13:23:50 `toolName=none`, `requests=2`, `failureReason=model_returned_without_tool`, 11.097 ms; 13:25:43 `search_flights` thành công với một request. Thời gian đã đổi UTC sang Asia/Saigon. |
| `src/agent/hybrid-search-agent.ts` (chỉ đọc) | Cấu hình `toolChoice=required`; đã thử phục hồi một lần khi không có tool. Câu trả lời lỗi chung không phải kết quả thiếu trường tuyến/ngày. |
| `src/storage/hybrid-search-session-store.ts` và session local (chỉ đọc) | Session lưu trên đĩa vẫn giữ cả lượt 5/2 thất bại và lượt 6/2 thành công; restart tiến trình không xóa ngữ cảnh này. |

**Kết luận đã xác minh:** lượt lỗi dừng ở ranh giới quyết định model/provider–SDK, trước khi thực thi tool tìm chuyến. Người dùng xác nhận reset bằng cách dừng rồi chạy lại `pnpm run telegram:dev`. Lượt thành công đồng thời đổi ngày từ 5/2 sang 6/2, nên chưa chứng minh restart là nguyên nhân hồi phục. Log cũng ghi nhận cùng loại lỗi không có tool từ 2026-09-14, trước thay đổi thông báo chờ.

**Giới hạn:** log hiện tại không giữ cấu trúc phản hồi thô của provider; chưa thể phân biệt model không tạo tool call, proxy chuyển đổi không đúng, hay SDK không nhận được tool call phù hợp. Không kết luận lỗi constants, mất session, 429 hoặc lỗi mạng từ bằng chứng này. Chưa chạy lại API/Telegram/browser thật. Không chạy lại build vì chỉ cập nhật Markdown.


### 2026-09-15 — Upload file và thông báo chờ

| Nhóm | File | Thay đổi trong đợt này |
| --- | --- | --- |
| Source | [telegram-bot.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-bot.ts>) | Bật mặc định `NTBA_FIX_350=1` trước khi tạo bot để dùng chế độ upload mới, loại bỏ cảnh báo content-type cũ. Giữ metadata ảnh và archive hiện có. |
| Source | [hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Thêm `onProcessingStarted` sau khi lưu nhận xử lý message và qua kiểm tra quyền/trạng thái/trùng lặp, trước khi gọi model. Lỗi callback không làm hỏng lượt xử lý. |
| Source | [telegram-hybrid-search.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-hybrid-search.ts>) | Gửi “⏳ Mình đã nhận yêu cầu, đang xử lý. Bạn chờ một chút nhé.” trả lời trực tiếp tin người dùng. Giới hạn chờ gửi 1,5 giây; xử lý lỗi đồng bộ, bất đồng bộ và rejection đến muộn. |
| Test mới | [test-telegram-file-uploads.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-telegram-file-uploads.ts>) | Kiểm tra formatter thật của thư viện: PNG, metadata archive, loại file không xác định và không còn cảnh báo upload. |
| Test mới | [test-telegram-waiting-feedback.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-telegram-waiting-feedback.ts>) | Kiểm tra tin chờ xuất hiện trước kết quả, liên kết reply, gửi lỗi/treo không chặn kết quả, không để lọt rejection đến muộn. |
| Test cập nhật | [test-hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-agent.ts>) | Kiểm tra callback chạy sau durable claim và trước model; bỏ qua message trùng và agent bị tắt; callback lỗi không hủy lượt xử lý. |
| Test cập nhật | [test-hybrid-search-telegram.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-telegram.ts>) | Cho runner giả lập thực thi callback; kiểm tra luồng ảnh/kết quả và không gửi thêm thông báo khi message bị giao lại. |

**Kiểm chứng đã hoàn tất khi triển khai:** hai test mới tái hiện lỗi trước sửa và qua sau sửa; các suite hybrid agent, hybrid Telegram, Telegram crash và error sanitizer đều qua; `pnpm build` và `git diff --check` qua. Kiểm thử offline, không gửi tin/ảnh thật lên Telegram, không gọi AI hoặc đặt chỗ thật. Cần khởi động lại bot để nạp code mới.

### 2026-09-15 — Sửa crash khi thông báo lỗi cũng gửi thất bại

| File | Thay đổi trong đợt này |
| --- | --- |
| [telegram-bot.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-bot.ts>) | Bắt riêng lỗi gửi thông báo dự phòng trong cả listener message và callback. Ghi log đã che token, không retry nghiệp vụ. |
| [test-telegram-bot-errors.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-telegram-bot-errors.ts>) | Test mới cho lỗi kép, sự kiện tiếp theo vẫn xử lý, không replay, log che token và listener polling/error. |

**Kiểm chứng:** tiến trình giả lập cùng lỗi `ECONNRESET` trước sửa thoát code 1; sau sửa thoát code 0, không còn rejection thoát ra. Test hồi quy, test Telegram liên quan, build và diff check qua. Nguyên nhân kết nối mạng bị reset ban đầu chưa được xác định; bản sửa xử lý đường gây crash trong ứng dụng.

### 2026-09-14 — Sửa câu trả lời ghép sai tên và mã sân bay

| File | Thay đổi trong đợt này |
| --- | --- |
| [hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Câu hỏi dùng purpose/target có cấu trúc; tên–mã lấy từ catalog; bỏ qua văn bản question cũ; kiểm tra xung đột trước chuẩn hóa; chào hỏi/hướng dẫn không tự thay đổi draft. |
| [test-hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-agent.ts>) | Thêm test văn bản sai SGN/HAN, giá/PNR giả, bảo toàn draft, xung đột hai đầu chặng và toàn bộ catalog. |
| [test-hybrid-search-contract.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-contract.ts>) | Cập nhật kiểm tra hợp đồng hướng dẫn/clarification có cấu trúc. |

**Kiểm chứng khi triển khai:** bốn suite liên quan và build qua; thử qua 9Router thật trả đúng SGN → UIH ngày 01/02/2027 trên session test cô lập. Không chạy tìm chuyến trên browser hoặc gửi Telegram thật trong lần kiểm tra đó.

### 2026-09-15 — Cập nhật tài liệu truy vết (lượt hiện tại)

- [CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>): bổ sung nhật ký theo yêu cầu và từng file, phạm vi kiểm chứng, quy tắc cập nhật về sau; làm mới danh sách working tree. Lượt này chỉ sửa tài liệu.
- Kiểm tra danh sách file và link local với working tree. Không chạy lại build cho thay đổi chỉ có Markdown; kết quả build bên trên thuộc các đợt triển khai tương ứng.

## Danh sách working tree hiện tại

| File | Thay đổi |
| --- | --- |
| [.env.example](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/.env.example>) | Khai báo ngưỡng tuổi chưa có mặc định; thiếu cấu hình sẽ chặn xác nhận. Cập nhật mô tả hybrid; không sửa .env thật. |
| [docs/technical/BUSINESS_RULES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/BUSINESS_RULES.md>) | Quy tắc danh bạ riêng, consent, bản sao case, trạng thái không hold và chính sách tuổi đang chờ chốt. |
| [docs/technical/CHANGED_FILES.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/CHANGED_FILES.md>) | Nhật ký triển khai, bằng chứng kiểm thử, giới hạn và inventory Git hiện tại. |
| [docs/technical/HYBRID_AGENT_ARCHITECTURE.md](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/docs/technical/HYBRID_AGENT_ARCHITECTURE.md>) | Ghi phạm vi customer flow mới tách khỏi search tools và hold legacy. |
| [package.json](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/package.json>) | Thêm ba lệnh kiểm thử customer store, passenger interpreter và customer flow. |
| [src/agent/hybrid-passenger-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-passenger-agent.ts>) | SDK chỉ đề xuất dữ liệu có căn cứ trong tin hiện tại; giới hạn một lượt, kiểm tra tên/giới tính/DOB, lookup riêng và lỗi an toàn. |
| [src/agent/hybrid-search-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/agent/hybrid-search-agent.ts>) | Sinh nút chọn theo ID từng trang; vô hiệu xác nhận khách khi search thay đổi. |
| [src/passengers/customer-passenger-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/passengers/customer-passenger-store.ts>) | Bảng SQLite riêng; owner-scoped read/list/create/update, phân trang, idempotency và optimistic version. |
| [src/passengers/customer-passenger-types.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/passengers/customer-passenger-types.ts>) | Hợp đồng hồ sơ khách cá nhân tách khỏi dữ liệu legacy. |
| [src/passengers/hybrid-passenger-state.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/passengers/hybrid-passenger-state.ts>) | Schema draft/trường chờ/revision/xác nhận; binding case/snapshot/candidate và dấu vân tay yêu cầu. |
| [src/services/hybrid-customer-passenger-service.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/services/hybrid-customer-passenger-service.ts>) | State machine chọn chuyến, nhập/chọn khách, xác nhận, opt-in lưu và preview cập nhật; không gọi hold. |
| [src/services/hybrid-customer-selection.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/services/hybrid-customer-selection.ts>) | Kiểm tra nguồn chuyến, tuyến/ngày, bộ lọc, freshness và vô hiệu xác nhận khi yêu cầu thay đổi. |
| [src/storage/hybrid-search-session-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/storage/hybrid-search-session-store.ts>) | Con trỏ passengerCaseId tùy chọn, tương thích session cũ. |
| [src/storage/local-case-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/storage/local-case-store.ts>) | Lưu flow/bản sao xác nhận theo case và hai trạng thái hybrid riêng. |
| [src/telegram/telegram-hybrid-search.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-hybrid-search.ts>) | Routing customer chat/callback, nút chọn dưới ảnh, một thông báo chờ dùng chung và cập nhật help. |
| [src/telegram/telegram-passenger-message-handler.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/src/telegram/telegram-passenger-message-handler.ts>) | Cho phép callback customer mới trong hybrid; giữ chặn callback hold legacy. |
| [tests/test-customer-passenger-store.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-customer-passenger-store.ts>) | SQLite tạm: owner isolation, trùng tên, phân trang, consent idempotency, version và migration không đổi legacy. |
| [tests/test-hybrid-customer-flow.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-customer-flow.ts>) | Case/session/DB tạm: nhiều lượt, SDK giả, restart, sửa/cancel/consent, nút cũ, no-hold và thiếu chính sách tuổi. |
| [tests/test-hybrid-passenger-agent.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-passenger-agent.ts>) | Model SDK giả: literal evidence, DOB mâu thuẫn, tên trùng từ giới tính, browse và timeout/429 không retry. |
| [tests/test-hybrid-search-pagination.ts](<C:/Users/letha/OneDrive/my_source_code/bookingFlightAgent/tests/test-hybrid-search-pagination.ts>) | Kiểm tra nút chọn trên 57 chuyến/12 trang, đúng ảnh; subprocess đóng worker trước cleanup để tránh EBUSY trên Windows. |

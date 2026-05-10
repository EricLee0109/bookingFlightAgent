# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests\1booking.spec.ts >> search 1booking flights
- Location: tests\1booking.spec.ts:4:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('div').filter({ hasText: /^tìm thấy 15 kết quả$/ }).nth(2)
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('div').filter({ hasText: /^tìm thấy 15 kết quả$/ }).nth(2)

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e4]:
    - complementary:
      - generic:
        - generic:
          - generic:
            - generic:
              - generic [ref=e5]:
                - img "Công Ty TNHH Tm & Dv N.K.B" [ref=e7]
                - generic [ref=e8]:
                  - button "Switch customer" [ref=e9] [cursor=pointer]:
                    - generic [ref=e10]: Công Ty TNHH Tm & Dv N.K.B
                    - img "Switch customer"
                  - generic [ref=e11]:
                    - generic [ref=e13]:
                      - generic [ref=e14]: hạn mức
                      - generic [ref=e15]:
                        - generic [ref=e17]:
                          - generic [ref=e18]: VND
                          - generic [ref=e19]: "0"
                        - button "Hide budget" [ref=e20] [cursor=pointer]:
                          - img "Show budget"
                    - button "Open balance settings" [ref=e22] [cursor=pointer]:
                      - img "Balance settings"
              - button [ref=e23] [cursor=pointer]:
                - img [ref=e25]
            - generic:
              - generic [ref=e28]:
                - img [ref=e29]
                - text: vi
              - generic [ref=e32] [cursor=pointer]:
                - img [ref=e33]
                - paragraph [ref=e36]: VND - VIET NAM DONG
            - generic:
              - generic:
                - menu [ref=e37]:
                  - menuitem "Dashboard Trang chủ" [ref=e38] [cursor=pointer]:
                    - link "Dashboard" [ref=e39]:
                      - /url: /dashboard
                      - img "Dashboard"
                    - link "Trang chủ" [ref=e41]:
                      - /url: /dashboard
                  - menuitem "Order Đơn hàng" [ref=e42] [cursor=pointer]:
                    - img "Order"
                    - generic [ref=e43]: Đơn hàng
                  - menuitem "text Thống kê" [ref=e44] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e45]: Thống kê
                - menu [ref=e46]:
                  - menuitem "text Vé máy bay" [ref=e47] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e48]: Vé máy bay
                - menu [ref=e49]:
                  - menuitem "text Đối tác" [ref=e50] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e51]: Đối tác
                  - menuitem "text Người dùng" [ref=e52] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e53]: Người dùng
                  - menuitem "text Quản lý chính sách" [ref=e54] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e55]: Quản lý chính sách
                  - menuitem "text Quản lý thanh toán" [ref=e56] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e57]: Quản lý thanh toán
                - menu [ref=e58]:
                  - menuitem "Settings Vé điện tử" [ref=e59] [cursor=pointer]:
                    - img "Settings"
                    - generic [ref=e60]: Vé điện tử
                  - menuitem "text Cấu hình vé máy bay" [ref=e61] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e62]: Cấu hình vé máy bay
                - menu [ref=e63]:
                  - menuitem "text Hàng không" [ref=e64] [cursor=pointer]:
                    - img "text"
                    - generic [ref=e65]: Hàng không
                  - menuitem "text Yêu cầu hỗ trợ" [ref=e66] [cursor=pointer]:
                    - link "text" [ref=e67]:
                      - /url: /request-support
                      - img "text"
                    - link "Yêu cầu hỗ trợ" [ref=e69]:
                      - /url: /request-support
          - generic [ref=e70]:
            - button [ref=e71] [cursor=pointer]:
              - img [ref=e73]
            - link "1Booking":
              - /url: /dashboard
              - img "1Booking"
    - generic [ref=e79]:
      - generic [ref=e80]:
        - generic [ref=e81]:
          - generic [ref=e82]:
            - img "text"
          - button "Edit search criteria" [ref=e83] [cursor=pointer]:
            - generic [ref=e84]:
              - generic [ref=e85]:
                - generic [ref=e86]:
                  - generic [ref=e87]: HAN
                  - generic [ref=e88]:
                    - img "OneWay"
                  - generic [ref=e89]: SGN
                - generic [ref=e90]:
                  - img "Edit"
              - generic [ref=e91]:
                - generic [ref=e92]: 10/05,
                - generic [ref=e94]: 1 ADT
        - generic [ref=e95]:
          - generic [ref=e96]:
            - img "text"
          - generic [ref=e97]:
            - img "text"
          - generic [ref=e98]:
            - img "text"
      - generic [ref=e104]:
        - generic [ref=e107]:
          - generic [ref=e108] [cursor=pointer]:
            - img "text"
          - generic [ref=e109]: tìm thấy 2 kết quả
        - generic [ref=e110]:
          - generic [ref=e111]:
            - img [ref=e113]
            - paragraph [ref=e118]: Giá vé cho các chuyến bay có thể thay đổi. Vui lòng đặt chỗ để lấy giá chính xác nhất.
          - button [ref=e119] [cursor=pointer]:
            - img [ref=e120]
        - list "Single ticket options" [ref=e124]:
          - generic [ref=e126] [cursor=pointer]:
            - generic [ref=e127]:
              - img "Sun PhuQuoc Airways" [ref=e133]
              - generic [ref=e135]: 9G893
            - generic [ref=e136]:
              - generic [ref=e137]: 23:05
              - generic [ref=e138]: "-"
              - generic [ref=e139]:
                - text: 01:15
                - generic [ref=e140]: "+1"
            - generic [ref=e142]: HAN - SGN
            - generic [ref=e143]: Bay thẳng
            - generic [ref=e146]: 32Q
            - generic [ref=e149]: 9G
            - generic [ref=e151]:
              - generic [ref=e152]: W4
              - img "text"
            - generic [ref=e153]: 3,537,000
          - generic [ref=e157] [cursor=pointer]:
            - generic [ref=e158]:
              - img "Vietnam Airlines" [ref=e164]
              - generic [ref=e166]: VN7207
            - generic [ref=e167]:
              - generic [ref=e168]: 22:55
              - generic [ref=e169]: "-"
              - generic [ref=e170]:
                - text: 01:10
                - generic [ref=e171]: "+1"
            - generic [ref=e173]: HAN - SGN
            - generic [ref=e174]: Bay thẳng
            - generic [ref=e177]: A321
            - generic [ref=e180]: VN
            - generic [ref=e182]:
              - generic [ref=e183]: B6
              - img "text"
            - generic [ref=e184]: 3,841,000
  - generic [ref=e188]:
    - button "close" [ref=e189] [cursor=pointer]:
      - img "close"
    - generic [ref=e190]:
      - button "Vé máy bay" [ref=e191] [cursor=pointer]:
        - generic [ref=e192]:
          - img "text"
      - button "eSIM" [ref=e193] [cursor=pointer]:
        - generic [ref=e194]:
          - img "esim"
  - region "Notifications Alt+T"
```

# Test source

```ts
  1  | import test, { expect } from "@playwright/test";
  2  | import { chromium } from "@playwright/test";
  3  | 
  4  | test('search 1booking flights', async ({ page }) => {
  5  |     await page.goto('https://pro.1booking.vn/');
  6  | 
  7  |     await page.getByRole('button', { name: 'Đăng nhập' }).click();
  8  |     await page.getByRole('textbox', { name: '* Mã đại lý' }).click();
  9  |     await page.getByRole('textbox', { name: '* Mã đại lý' }).fill('HS2200389');
  10 |     await page.getByRole('textbox', { name: '* Tên đăng nhập' }).click();
  11 |     await page.getByRole('textbox', { name: '* Tên đăng nhập' }).fill('LETHAIKHOA');
  12 |     await page.getByRole('textbox', { name: '* Mật khẩu' }).click();
  13 |     await page.getByRole('textbox', { name: '* Mật khẩu' }).fill('Kimngan$2026');
  14 |     await page.getByRole('button', { name: 'Đăng nhập' }).click();
  15 |     await page.locator('div').filter({ hasText: /^LƯU Ý QUAN TRỌNG$/ }).click();
  16 |     await page.getByRole('button', { name: 'Close' }).click();
  17 |     await page.getByRole('textbox', { name: 'Chọn điểm đi' }).click();
  18 |     await page.getByRole('textbox', { name: 'Chọn điểm đi' }).fill('HAN');
  19 |     await page.locator('div').filter({ hasText: /^Sân bay Nội Bài \(HAN\)Hà Nội, Việt Nam$/ }).first().click();
  20 |     await page.getByRole('textbox', { name: 'Chọn điểm đến' }).click();
  21 |     await page.getByRole('textbox', { name: 'Chọn điểm đến' }).fill('SGN');
  22 |     await page.locator('.cursor-pointer.rounded-lg').click();
  23 |     await page.getByRole('button', { name: 'search-ic Tìm kiếm' }).click();
> 24 |     await expect(page.locator('div').filter({ hasText: /^tìm thấy 15 kết quả$/ }).nth(2)).toBeVisible();
     |                                                                                           ^ Error: expect(locator).toBeVisible() failed
  25 | 
  26 |     await page.screenshot({ path: "flights-screenshots/screenshot-1booking.png", fullPage: true });
  27 | 
  28 | });
  29 | 
```
# AINovel — API cho ứng dụng mobile

Tài liệu để team mobile ghép API. Chỉ gồm các endpoint app gọi trực tiếp. Không gồm API CMS (`/admin/*`), callback của đối tác (`/postback/*`) hay hạ tầng.

Mọi field, mã lỗi và giới hạn trong tài liệu được lấy từ code backend (schema TypeBox + service). Khi tài liệu và hành vi thực tế khác nhau, code là chuẩn; hãy báo team backend để sửa tài liệu.

## Mục lục

0. [Quy ước chung](#0-quy-ước-chung)
1. [Cấu hình (Config)](#1-cấu-hình-config)
2. [Xác thực (Auth)](#2-xác-thực-auth)
3. [Hộp thư (Inbox)](#3-hộp-thư-inbox)
4. [Truyện (Novel)](#4-truyện-novel)
5. [Quảng cáo thưởng (Rewarded ads)](#5-quảng-cáo-thưởng-rewarded-ads)
6. [Ví & lịch sử coin](#6-ví--lịch-sử-coin)
7. [Điểm danh](#7-điểm-danh)
8. [Nhiệm vụ](#8-nhiệm-vụ)
9. [Nhận coin trực tiếp](#9-nhận-coin-trực-tiếp)
10. [Offerwall](#10-offerwall)
11. [Vòng quay (Spin)](#11-vòng-quay-spin)
12. [Giới thiệu bạn bè (Referral)](#12-giới-thiệu-bạn-bè-referral)
13. [Đổi quà (Catalog & Redemption)](#13-đổi-quà-catalog--redemption)
14. [Phản hồi & báo cáo](#14-phản-hồi--báo-cáo)

## 0. Quy ước chung

### Base URL

| Môi trường  | Base URL                          |
| ----------- | --------------------------------- |
| Production  | `https://novel.honey-play.com/v1` |
| Local (dev) | `http://localhost:3000/v1`        |

Mọi route đều được đăng ký cả ở gốc (`/config`) lẫn dưới `/v1` (`/v1/config`). App nên dùng `/v1`. Trong tài liệu, đường dẫn được viết không kèm `/v1` cho gọn.

Request và response đều là JSON (`Content-Type: application/json`), mã hoá UTF-8.

### Header

| Header            | Bắt buộc      | Mô tả                                                                                                                                                                                                                                                     |
| ----------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-App-Version`   | Có*           | Phiên bản app, ví dụ `1.4.0`. Server không tự chặn theo version; app tự so với `min_supported_app_version` trong `GET /config`.                                                                                                                           |
| `X-Device-Id`     | Có*           | Installation id: UUID (khuyến nghị v4) app tự sinh **một lần** khi cài và lưu bền. Đây là khoá khôi phục tài khoản guest; cài lại app sinh id mới, nên tài khoản guest chưa liên kết sẽ mất. Các route tạo tài khoản bắt buộc giá trị này là UUID hợp lệ. |
| `Accept-Language` | Có*           | Ví dụ `vi-VN`, `en-US`.                                                                                                                                                                                                                                   |
| `Authorization`   | Theo endpoint | `Bearer <access_token>` cho các endpoint ghi **Auth: Bearer**.                                                                                                                                                                                            |

\* Ba header này bắt buộc ở mọi nhóm route trừ nhóm Truyện (mục 4), `GET /me/stats`, `GET/PUT /me/preferences` và mục Phản hồi & báo cáo (mục 14). Thiếu một header sẽ trả `400 VALIDATION_ERROR`. **Khuyến nghị: luôn gửi cả ba trong mọi request** (đặt ở interceptor của HTTP client).

### Token và phiên đăng nhập

- **Access token** là JWT, hạn **1 giờ**. Gửi qua `Authorization: Bearer`.
- **Refresh token** là JWT, hạn **30 ngày** tính từ lần refresh gần nhất. Dùng với `POST /auth/refresh`.
- Refresh token **chỉ dùng được một lần**. Mỗi lần refresh, server trả cặp token mới và thu hồi refresh token cũ. Nếu một refresh token cũ bị dùng lại, server trả `401 REFRESH_TOKEN_REUSED` và **thu hồi mọi phiên** của user trên mọi thiết bị. Vì vậy app phải:
  - chỉ chạy **một** request refresh tại một thời điểm; các request khác chờ request này xong;
  - lưu cặp token mới ngay lập tức (atomic) trước khi gửi lại request bị lỗi.
- Xử lý lỗi 401:

| Mã                                   | Ý nghĩa                                                        | App nên làm                         |
| ------------------------------------ | -------------------------------------------------------------- | ----------------------------------- |
| `UNAUTHORIZED`                       | Thiếu header `Authorization`                                   | Lỗi lập trình: kiểm tra interceptor |
| `INVALID_ACCESS_TOKEN`               | Access token sai hoặc hết hạn                                  | Refresh rồi gửi lại request         |
| `SESSION_REVOKED`                    | Phiên đã bị thu hồi (logout, đổi mật khẩu, tài khoản bị khoá…) | Xoá token, về màn đăng nhập         |
| `REFRESH_TOKEN_REUSED` / refresh lỗi | Refresh token không còn hợp lệ                                 | Xoá token, về màn đăng nhập         |

### Định dạng lỗi

Mọi lỗi có cùng dạng:

```json
{
  "error": {
    "code": "CHAPTER_LOCKED",
    "message": "This chapter must be unlocked first",
    "chapter_id": "…",
    "unlock_price": 50,
    "ad_unlock": true
  }
}
```

- Dựa vào `code` để xử lý; `message` là tiếng Anh, chỉ để debug, **không hiển thị trực tiếp** cho người dùng.
- Một số lỗi có thêm field cùng cấp với `code` để app xử lý (ví dụ `claimable_at` của `REDEMPTION_HOLD_ACTIVE`, giá mở khoá của `CHAPTER_LOCKED`). Các field này được ghi ở từng endpoint.

Lỗi dùng chung:

| HTTP        | Mã                      | Khi nào                                                                                                                                                                                                                                                                                               |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400         | `VALIDATION_ERROR`      | Body, query, params hoặc header sai schema                                                                                                                                                                                                                                                            |
| 400/413/415 | `BAD_REQUEST`           | Body không phải JSON hợp lệ, gửi `Content-Type: application/json` nhưng body rỗng, Content-Type không hỗ trợ, hoặc body quá lớn. Với POST không có body (`/auth/logout`, `/auth/logout-all`, `/inbox/:id/read`, `/spin/free`…), không gửi header `Content-Type: application/json`, hoặc gửi body `{}` |
| 404         | `NOT_FOUND`             | Route không tồn tại                                                                                                                                                                                                                                                                                   |
| 429         | `RATE_LIMITED`          | Vượt giới hạn tần suất của route. Không có header `Retry-After`; app nên chờ vài giây rồi thử lại                                                                                                                                                                                                     |
| 429         | `UNBACKED_CAP_EXCEEDED` | Khoản cộng này làm tổng coin "miễn phí" (điểm danh, nhiệm vụ, đọc truyện, spin miễn phí, nhận coin trực tiếp…) trong 30 ngày vượt 20.000. Welcome/Google bonus được tính vào tổng nhưng bản thân không bị chặn                                                                                        |
| 429         | `MINT_PAUSED`           | Hệ thống đang tạm dừng phát coin ở region này                                                                                                                                                                                                                                                         |
| 500         | `INTERNAL_ERROR`        | Lỗi server; có thể thử lại sau                                                                                                                                                                                                                                                                        |

### Kiểu dữ liệu

- **Thời gian**: chuỗi ISO 8601 UTC, ví dụ `"2026-10-14T08:30:00.000Z"`.
- **Coin**:
  - Số dư và số tiền lưu trong DB (`available_coin`, `pending_coin`, `amount`, `balance_after`, `new_balance`, `coin_price`…) là **string**. Hãy parse thành số nguyên 64-bit; không dùng float.
  - Mức thưởng lấy từ cấu hình (`chapter_reward_coin`, `credited_coin`, `reward_coin`…) là **number**.
- **ID**: UUID dạng chuỗi.
- **Region**: server tự suy ra từ IP (`VN` hoặc `ROW`); app không gửi region. Tính năng bật hay tắt và mức thưởng theo region đều lấy từ `GET /config`. Lưu ý: `GET /config` suy region từ IP của **request hiện tại**, còn việc cộng thưởng (đọc truyện, điểm danh…) dùng region gắn với tài khoản lúc tạo (`region_id` trong `/me`). Hai giá trị có thể khác nhau khi user dùng VPN hoặc ra nước ngoài.

### Luồng khởi động app (gợi ý)

1. Lấy hoặc sinh `X-Device-Id`.
2. `GET /config` để biết tính năng đang bật, mức thưởng và phiên bản tối thiểu. Hỗ trợ ETag: gửi `If-None-Match`, server trả `304` nếu không có thay đổi.
3. Nếu chưa có token: `POST /auth/guest` để tạo tài khoản guest (hoặc khôi phục tài khoản guest cũ của thiết bị). Nếu đã có token: `GET /me`.
4. Muốn giữ tài khoản khi đổi máy: liên kết bằng `POST /auth/bind` (Google/Facebook) hoặc `POST /auth/password/bind`. **Không** gọi `/auth/google` hay `/auth/password/register` khi đang là guest (sẽ nhận `409 SIGNUP_BLOCKED`).

## 1. Cấu hình (Config)

### `GET /config`

Lấy cấu hình tính năng theo region (suy ra từ IP) để app bật/tắt UI và hiển thị tham số thưởng. **Auth:** Không. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language` (bắt buộc); `If-None-Match` (tuỳ chọn, giá trị ETag lần trước).

Request: không có body/query.

Response 200:

```json
{
  "region": "VN",
  "features": {
    "novel": {
      "enabled": true,
      "chapter_reward_coin": 50,
      "reading_wpm": 300,
      "min_read_ratio": 0.5,
      "min_read_seconds": 30,
      "max_read_seconds": 900,
      "completion_scroll_ratio": 0.9,
      "chapter_reward_daily_cap": 20
    },
    "spin": {
      "enabled": true,
      "ticket_coin": 500,
      "daily_cap": 10,
      "odds_disclosure": "Displayed odds are base odds; pity can improve high-tier odds."
    },
    "offerwall": { "enabled": false, "networks": [], "share_pct": 0 },
    "rewarded_ads": {
      "enabled": true,
      "daily_cap": 20,
      "cooldown_s": 30,
      "placements": {
        "checkin": { "daily_cap": 5, "cooldown_s": 30, "coin_multiplier": 1 },
        "luckyspin": { "daily_cap": 5, "cooldown_s": 30, "coin_multiplier": 0 }
      }
    },
    "checkin": { "enabled": true, "rewards": [10, 15, 20, 25, 30, 40, 100] },
    "tasks": { "enabled": true },
    "redemption": { "enabled": true },
    "referral": {
      "enabled": true,
      "pct": 0.1,
      "milestone_bonus_coin": 0,
      "milestone_bonus_threshold": 0,
      "credit_immediately": false
    }
  },
  "welcome": { "mode": "instant", "coin": 10000 },
  "coin_per_usd": 10000,
  "min_supported_app_version": "1.0.0",
  "min_redemption_usd": 5
}
```

Response 304: body rỗng, khi `If-None-Match` trùng ETag hiện tại.

Ghi chú:

- Response luôn có header `ETag` và `Cache-Control: private, max-age=60`. Server cache config 60s theo region.
- `region`: `"VN"` hoặc `"ROW"` (rest-of-world).
- Mỗi object trong `features` là free-form (`Record<string, unknown>`); các key ở trên là các key server hiện đang build. `spin` chỉ còn `{ "enabled": false }` khi tính năng tắt hoặc khi region chưa gắn bảng spin đang active. Các giá trị khác khi chưa cấu hình sẽ về `false`/`0`/`[]`, riêng `novel.*` về mặc định (`reading_wpm` 300, `min_read_ratio` 0.5, `min_read_seconds` 30, `max_read_seconds` 900, `completion_scroll_ratio` 0.9, `chapter_reward_daily_cap` 20).
- `novel.*` và `rewarded_ads.placements` chỉ để hiển thị; việc cộng coin luôn do server quyết định. Placement hợp lệ: `checkin`, `earncoin`, `luckyspin`, `chapter_unlock` (chỉ có key nào đã được cấu hình).
- `offerwall.share_pct`: phần trăm (0-100) cho trust level 0. `referral.pct` là tỉ lệ thập phân (vd 0.10 = 10%), khác với `share_pct`. `checkin.rewards`: mảng coin theo ngày check-in. `offerwall.networks`, `checkin.rewards` được trả nguyên từ DB.
- `welcome`: coin chào mừng (cấu hình chung, không theo region). `mode` = `welcome_mode` của `GET /auth/login-offers`: `instant` → màn welcome "Bạn nhận N coin"; `link_required` → màn welcome pending "Liên kết tài khoản để nhận N coin". Khi admin đổi trong CMS, cache server bị xoá ngay; app thấy giá trị mới ở lần gọi `/config` kế tiếp (HTTP cache của chính app vẫn có thể giữ tối đa 60s).
- `coin_per_usd` cố định 10000. `min_supported_app_version`: client tự so với version của mình để ép cập nhật.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header bắt buộc.
- `500 CONFIG_NOT_FOUND` — region chưa có `region_config`.
- `500 CONFIG_MALFORMED` — `region_config.features` sai định dạng.

## 2. Xác thực (Auth)

Object `device` dùng chung trong body của các route tạo tài khoản:

| Field         | Type                  | Bắt buộc | Ràng buộc / ghi chú                                                                                                                                       |
| ------------- | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`       | string                | Có       | minLength 1 (vd `"Pixel 8"`)                                                                                                                              |
| `os`          | string                | Có       | minLength 1 (vd `"Android 15"`)                                                                                                                           |
| `gaid`        | string \| null        | Không    | maxLength 128. Google Advertising ID; chỉ dùng cho chống gian lận và migrate tài khoản guest cũ. Giá trị không phải UUID hoặc zero-UUID bị coi như `null` |
| `build_props` | object<string,string> | Không    | Thông tin build tuỳ ý; chỉ dùng cho fingerprint legacy                                                                                                    |

Object `user` trả về trong các response đăng nhập/đăng ký (`AuthResult`):

```json
{
  "access": "eyJhbGciOiJIUzI1NiIs...",
  "refresh": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "0192f3a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e",
    "public_id": "10284731",
    "auth_provider": "guest",
    "trust_level": 0,
    "region_id": "VN",
    "country_code": "VN",
    "referral_code": "K7Q2MX",
    "created_at": "2026-10-14T08:30:00.000Z"
  }
}
```

- `auth_provider`: `guest` | `google` | `facebook` | `password` (phương thức đăng nhập "chính" hiện tại).
- `public_id`: ID số để hiển thị ở màn hồ sơ ("ID 10284731") và đọc cho bộ phận hỗ trợ; **string** (bigint), ≥ 8 chữ số, không đổi suốt đời tài khoản. Chỉ để hiển thị — mọi API vẫn dùng `id` (UUID).
- `country_code`: mã ISO quốc gia theo IP lúc tạo tài khoản (`"XX"` nếu không xác định).
- `referral_code`: mã giới thiệu của chính user (có thể `null` với tài khoản cũ).
- Các route này không khai báo response schema nên có thể có thêm field (vd `recovered`). Response KHÔNG chứa số dư ví — gọi `GET /me` để lấy.

### `GET /auth/login-offers`

Lấy số coin thưởng khi đăng ký/đăng nhập theo từng phương thức, để hiển thị trên màn đăng nhập. **Auth:** Không. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request: không có.

Response 200:

```json
{
  "items": [
    {
      "auth_provider": "password",
      "welcome_coin": 1000,
      "provider_bonus_coin": 0,
      "total_coin": 1000
    },
    {
      "auth_provider": "google",
      "welcome_coin": 1000,
      "provider_bonus_coin": 500,
      "total_coin": 1500
    }
  ],
  "welcome_mode": "instant",
  "updated_at": "2026-10-01T00:00:00.000Z"
}
```

- `welcome_mode` (CMS cấu hình):
  - `instant`: mọi tài khoản mới, kể cả guest, nhận `welcome_coin` ngay khi tạo. App hiện màn "Welcome gift".
  - `link_required`: guest **chưa** nhận `welcome_coin`; coin được cộng khi guest liên kết Google/Facebook (`POST /auth/bind`) hoặc thêm mật khẩu (`POST /auth/password/bind`). App hiện màn "Welcome gift — Pending" với nút "Link Google & claim". Tài khoản tạo thẳng bằng Google/Facebook/mật khẩu vẫn nhận ngay.
- Coin là integer. Chỉ có 2 item `password` và `google` (không có `facebook`/`guest`; thực tế guest và facebook cũng nhận `welcome_coin`, chỉ Google có `provider_bonus_coin`).

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header.

### `POST /auth/guest`

Đăng ký tài khoản khách (guest) gắn với installation id, hoặc khôi phục tài khoản guest đã có trên cùng installation. **Auth:** Không. **Headers:** `X-Device-Id` (UUID v1-5, bắt buộc), `X-App-Version`, `Accept-Language`.

Request:

```json
{
  "device": {
    "gaid": "38400000-8cf0-11bd-b23e-10b96e40000d",
    "model": "Pixel 8",
    "os": "Android 15"
  }
}
```

Response 200: `AuthResult` (xem trên). Khi khôi phục tài khoản guest có sẵn sẽ có thêm `"recovered": true` (tài khoản mới thì không có field này).

Side effects:

- Tài khoản mới: tạo user + ví + device, nhận `welcome_coin` (một lần duy nhất mỗi user; khi `welcome_mode = link_required` thì chưa nhận, xem `GET /auth/login-offers`), `trust_level` = 0, sinh `referral_code`.
- Khôi phục: tìm theo installation id (fallback một lần theo fingerprint GAID+model+os+build_props cho tài khoản cũ), cấp session mới; nếu user chưa từng nhận welcome bonus thì được cộng bù (trừ khi `welcome_mode = link_required`: khi đó vẫn phải liên kết tài khoản mới nhận).

Rate limit: 20 req/60s/IP. Khôi phục: 5 lần/giờ/installation. Tạo tài khoản mới: 60/giờ/mạng (/24 IPv4 hoặc /64 IPv6) và 3/24h/GAID.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu/sai header (X-Device-Id không phải UUID), body sai.
- `400 INVALID_DEVICE_ID` — X-Device-Id không phải UUID hợp lệ khác 0 (thực tế thường bị bắt trước bởi VALIDATION_ERROR).
- `409 SIGNUP_USE_OAUTH` — installation này thuộc tài khoản đã bind Google/Facebook/password; app phải đưa user tới nút đăng nhập tương ứng.
- `409 DEVICE_IDENTITY_CONFLICT` — tài khoản guest legacy đã được migrate sang installation khác.
- `409 SIGNUP_BLOCKED` — thiết bị đã gắn với tài khoản khác không khôi phục được (vd tài khoản bị khoá/banned).
- `429 RATE_LIMITED` — vượt một trong các giới hạn ở trên.

### `POST /auth/google`

Đăng nhập/đăng ký bằng Google ID token. **Auth:** Không. **Headers:** `X-Device-Id` (UUID v1-5, bắt buộc), `X-App-Version`, `Accept-Language`.

Request:

| Field      | Type   | Bắt buộc | Ghi chú                                                                                                    |
| ---------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `id_token` | string | Có       | minLength 1. Google ID token (JWT). Trên Android phải lấy với `serverClientId` = Web client id của backend |
| `device`   | object | Có       | Xem bảng `device`                                                                                          |

```json
{ "id_token": "eyJhbGciOiJSUzI1NiIs...", "device": { "model": "Pixel 8", "os": "Android 15" } }
```

Response 200: `AuthResult`. Tài khoản mới có `user.auth_provider = "google"`; tài khoản đã có trả provider chính hiện tại của tài khoản (có thể khác `google`).

Side effects:

- Google identity đã tồn tại -> đăng nhập vào tài khoản đó (session mới). `device` được validate nhưng không ghi.
- Chưa tồn tại -> tạo tài khoản mới. Lưu ý: nếu installation (`X-Device-Id`) đã gắn với một tài khoản (vd guest hiện tại) thì bị `409 SIGNUP_BLOCKED` — guest muốn lên Google phải dùng `POST /auth/bind`.
- Thưởng một lần mỗi user: `welcome_coin` + Google bonus (`provider_bonus_coin` trong login-offers); tài khoản cũ chưa nhận sẽ được cộng bù ở lần đăng nhập.

Rate limit: 20 req/60s/IP.

Lỗi:

- `400 VALIDATION_ERROR` — header/body sai.
- `400 INVALID_DEVICE_ID` — X-Device-Id không hợp lệ.
- `401 INVALID_ID_TOKEN` — token Google không hợp lệ/hết hạn/sai audience.
- `403 CREDENTIAL_DISABLED` — phương thức đăng nhập này đã bị vô hiệu.
- `403 ACCOUNT_NOT_ACTIVE` — tài khoản bị khoá/suspended.
- `409 SIGNUP_BLOCKED` — (chỉ khi tạo mới) thiết bị đã gắn với tài khoản khác.
- `429 RATE_LIMITED`.
- `500 PROVIDER_NOT_CONFIGURED` — server chưa cấu hình Google client id.

### `POST /auth/facebook`

Đăng nhập/đăng ký bằng Facebook. **Auth:** Không. **Headers:** như `/auth/google`.

Request: giống `/auth/google`, nhưng `id_token` là **Facebook user access token** (server kiểm qua Graph API `debug_token` và đọc `email`), không phải OIDC id_token.

Response 200: `AuthResult`. Tài khoản mới có `user.auth_provider = "facebook"`; tài khoản đã có trả provider chính hiện tại của tài khoản (có thể khác `facebook`).

Side effects: như `/auth/google`, nhưng chỉ nhận `welcome_coin` (không có provider bonus).

Rate limit: 20 req/60s/IP.

Lỗi: giống `/auth/google`. `401 INVALID_ID_TOKEN` cũng xảy ra khi gọi Graph API lỗi mạng hoặc token thuộc app Facebook khác. `500 PROVIDER_NOT_CONFIGURED` nếu server chưa cấu hình Facebook app.

### `POST /auth/bind`

Liên kết Google hoặc Facebook vào tài khoản hiện tại (dùng để nâng cấp guest). **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

| Field      | Type   | Bắt buộc | Ràng buộc                                                |
| ---------- | ------ | -------- | -------------------------------------------------------- |
| `provider` | string | Có       | enum `google` \| `facebook`                              |
| `id_token` | string | Có       | minLength 1 (Google ID token hoặc Facebook access token) |

```json
{ "provider": "google", "id_token": "eyJhbGciOiJSUzI1NiIs..." }
```

Response 200: `AuthResult` — **cặp token mới** (session mới) và `user.auth_provider` đổi thành provider vừa bind. Session cũ vẫn còn hiệu lực; client nên thay bằng token mới.

Side effects: cộng `welcome_coin` nếu chưa nhận; bind Google cộng thêm Google bonus (một lần mỗi user).

Rate limit: 20 req/60s/user.

Lỗi:

- `400 VALIDATION_ERROR` — `provider` ngoài enum, body/header sai.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED` — lỗi guard.
- `401 INVALID_ID_TOKEN` — token provider không hợp lệ.
- `404 USER_NOT_FOUND`.
- `409 IDENTITY_TAKEN` — tài khoản Google/Facebook này đã gắn với user khác.
- `409 ALREADY_BOUND` — user đã liên kết provider này rồi.
- `429 RATE_LIMITED`.
- `500 PROVIDER_NOT_CONFIGURED`.

### `POST /auth/refresh`

Đổi refresh token lấy cặp token mới (rotation). **Auth:** Không. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

```json
{ "refresh": "eyJhbGciOiJIUzI1NiIs..." }
```

`refresh`: string, minLength 1.

Response 200:

```json
{ "access": "eyJhbGciOiJIUzI1NiIs...", "refresh": "eyJhbGciOiJIUzI1NiIs..." }
```

- Chỉ có 2 field, không có `user`. Refresh cũ bị thu hồi ngay; phải lưu refresh mới. Giữ nguyên session (`sid`); access mới mang `trust_level` hiện tại của user.

Rate limit: 60 req/60s/IP.

Lỗi:

- `400 VALIDATION_ERROR`.
- `401 INVALID_REFRESH_TOKEN` — sai chữ ký, hết hạn, không tồn tại, đã bị thu hồi (logout...), hoặc tài khoản không còn active (khi đó mọi session bị thu hồi).
- `401 REFRESH_TOKEN_REUSED` — refresh đã được rotate trước đó bị dùng lại; server thu hồi TẤT CẢ session của user -> buộc đăng nhập lại.
- `429 RATE_LIMITED`.

### `POST /auth/password/register`

Đăng ký tài khoản bằng username + email + mật khẩu. **Auth:** Không. **Headers:** `X-Device-Id` (UUID v1-5, bắt buộc), `X-App-Version`, `Accept-Language`.

Request:

| Field      | Type   | Bắt buộc | Ràng buộc                                               |
| ---------- | ------ | -------- | ------------------------------------------------------- |
| `username` | string | Có       | regex `^[A-Za-z0-9_]{3,24}$`; server lưu dạng lowercase |
| `email`    | string | Có       | 3-254 ký tự, dạng `a@b.c`; lưu lowercase                |
| `password` | string | Có       | 12-128 ký tự                                            |
| `device`   | object | Có       | Xem bảng `device`                                       |

```json
{
  "username": "reader_01",
  "email": "reader@example.com",
  "password": "correct-horse-battery",
  "device": { "model": "Pixel 8", "os": "Android 15" }
}
```

Response **201**: `AuthResult` với `user.auth_provider = "password"`.

Side effects: nhận `welcome_coin`; gửi email xác minh (link chứa `token`, hạn 24h). Đăng nhập không yêu cầu email đã xác minh, nhưng quên mật khẩu thì có.

Rate limit: 10 req/60s/IP và 5 req/60s/username.

Lỗi:

- `400 VALIDATION_ERROR` — vi phạm ràng buộc trên.
- `400 INVALID_DEVICE_ID`.
- `409 CREDENTIAL_UNAVAILABLE` — username hoặc email đã được dùng.
- `409 SIGNUP_BLOCKED` — installation này đã gắn với tài khoản khác (guest muốn thêm mật khẩu phải dùng `/auth/password/bind`).
- `429 RATE_LIMITED`.

### `POST /auth/password/login`

Đăng nhập bằng username + mật khẩu. **Auth:** Không. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

```json
{ "username": "reader_01", "password": "correct-horse-battery" }
```

- `username`: regex `^[A-Za-z0-9_]{3,24}$` (không phân biệt hoa thường). `password`: 12-128 ký tự. Không có `device`.

Response 200: `AuthResult`. `user.auth_provider` là provider chính của tài khoản (có thể là `google` nếu user bind mật khẩu sau khi đã có Google).

Side effects: session mới; cộng bù `welcome_coin` nếu chưa nhận.

Rate limit: 10 req/60s/IP và 5 req/60s/username.

Lỗi:

- `400 VALIDATION_ERROR` — kể cả mật khẩu < 12 ký tự hoặc username sai định dạng.
- `401 INVALID_CREDENTIALS` — sai username/mật khẩu hoặc credential bị vô hiệu.
- `403 ACCOUNT_NOT_ACTIVE` — tài khoản bị khoá.
- `429 RATE_LIMITED`.

### `POST /auth/password/bind`

Thêm đăng nhập bằng mật khẩu cho tài khoản hiện tại (vd guest). **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

```json
{ "username": "reader_01", "email": "reader@example.com", "password": "correct-horse-battery" }
```

Ràng buộc giống `/auth/password/register` (không có `device`).

Response 200:

```json
{ "message": "Password login linked. Check your email to verify it." }
```

- **Không** trả token mới; tiếp tục dùng token hiện tại. Nếu user đang là `guest` thì `auth_provider` đổi thành `password`; nếu đã là google/facebook thì giữ nguyên.

Side effects: cộng `welcome_coin` nếu chưa nhận; gửi email xác minh (hạn 24h).

Rate limit: 5 req/60s/user.

Lỗi:

- `400 VALIDATION_ERROR`.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.
- `404 USER_NOT_FOUND`.
- `409 ALREADY_BOUND` — tài khoản đã có mật khẩu.
- `409 CREDENTIAL_UNAVAILABLE` — username hoặc email đã được dùng.
- `429 RATE_LIMITED`.

### `POST /auth/password/change`

Đổi mật khẩu. **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

```json
{ "current_password": "correct-horse-battery", "new_password": "another-long-passphrase" }
```

Cả hai: string 12-128 ký tự.

Response 200:

```json
{ "message": "Password changed. Sign in again on your devices." }
```

- Thu hồi **tất cả** session, kể cả session hiện tại: access token đang dùng sẽ bị `401 SESSION_REVOKED` ở request kế tiếp và refresh cũng không dùng được -> app phải đưa user về màn đăng nhập.

Rate limit: 10 req/giờ/user.

Lỗi:

- `400 VALIDATION_ERROR`.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.
- `401 INVALID_CREDENTIALS` — mật khẩu hiện tại sai, tài khoản không có mật khẩu, hoặc credential bị vô hiệu.
- `429 RATE_LIMITED`.

### `POST /auth/password/forgot`

Yêu cầu email đặt lại mật khẩu. **Auth:** Không. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

```json
{ "email": "reader@example.com" }
```

`email`: 3-254 ký tự, dạng email.

Response 200 (luôn giống nhau, không tiết lộ email có tồn tại hay không):

```json
{ "message": "If a verified account exists, a password reset email has been sent." }
```

- Chỉ gửi mail khi email thuộc credential mật khẩu **đã xác minh email** và chưa bị vô hiệu. Link reset chứa query `token`, hạn **1 giờ**; yêu cầu mới làm vô hiệu các token reset cũ.

Rate limit: 5 req/giờ/IP và 3 req/giờ/email.

Lỗi:

- `400 VALIDATION_ERROR`.
- `429 RATE_LIMITED`.

### `POST /auth/password/reset`

Đặt mật khẩu mới bằng token từ email. **Auth:** Không. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

```json
{
  "token": "Qm9vZ2llV29vZ2llLXJhbmRvbS10b2tlbi0zMmJ5dGVz",
  "new_password": "another-long-passphrase"
}
```

- `token`: string 32-256 ký tự (lấy từ query `token` của link trong email). `new_password`: 12-128 ký tự.

Response 200:

```json
{ "message": "Password reset. Sign in with your new password." }
```

- Token chỉ dùng một lần. Thu hồi tất cả session của user.

Rate limit: 5 req/60s/IP.

Lỗi:

- `400 VALIDATION_ERROR`.
- `400 INVALID_RESET_TOKEN` — token sai, đã dùng, hết hạn, hoặc credential bị vô hiệu.
- `429 RATE_LIMITED`.

### `POST /auth/password/verify-email`

Xác minh email bằng token trong email xác minh. **Auth:** Không. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request:

```json
{ "token": "Qm9vZ2llV29vZ2llLXJhbmRvbS10b2tlbi0zMmJ5dGVz" }
```

`token`: string 32-256 ký tự.

Response 200:

```json
{ "message": "Email verified." }
```

- Token chỉ dùng một lần, hạn 24h. Không có endpoint gửi lại email xác minh.

Rate limit: 5 req/60s/IP.

Lỗi:

- `400 VALIDATION_ERROR`.
- `400 INVALID_VERIFICATION_TOKEN` — token sai, đã dùng hoặc hết hạn.
- `429 RATE_LIMITED`.

### `GET /auth/sessions`

Liệt kê các phiên đăng nhập còn hiệu lực của user. **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Response 200:

```json
{
  "items": [
    {
      "id": "0192f3a4-8a10-7c2d-b111-2a3b4c5d6e7f",
      "provider": "google",
      "device_id": "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b",
      "ip": "203.0.113.10",
      "user_agent": "okhttp/4.12.0",
      "created_at": "2026-10-01T03:00:00.000Z",
      "last_used_at": "2026-10-14T08:00:00.000Z",
      "expires_at": "2026-11-13T08:00:00.000Z",
      "current": true
    }
  ]
}
```

- `id`: session id (`sid`), ổn định qua các lần refresh. `current = true` cho session của access token đang gọi.
- `provider`: `guest` | `google` | `facebook` | `password`. `device_id` là giá trị header `X-Device-Id` lúc tạo/refresh session.
- `created_at`: lúc bắt đầu session; `last_used_at`/`expires_at`: của refresh token hiện tại. Sắp xếp `last_used_at` giảm dần.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.

### `DELETE /auth/sessions/:id`

Thu hồi một phiên (đăng xuất thiết bị khác, hoặc chính mình). **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Params: `id` (string) — session id từ `GET /auth/sessions`.

Response **204**: không body.

- Idempotent: id (UUID) không tồn tại, đã thu hồi hoặc thuộc user khác vẫn trả 204 (không có 404). `id` không đúng định dạng UUID hiện gây `500 INTERNAL_ERROR`; chỉ truyền `id` lấy từ `GET /auth/sessions`.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.

### `POST /auth/logout`

Đăng xuất phiên hiện tại (theo `sid` trong access token). **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request: không có body (không cần gửi refresh token).

Response **204**: không body. Refresh token của phiên này bị thu hồi; access token hiện tại bị từ chối ngay (`SESSION_REVOKED`).

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.

### `POST /auth/logout-all`

Đăng xuất tất cả phiên của user trên mọi thiết bị. **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Request: không có body.

Response **204**: không body.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.

### `GET /me`

Lấy hồ sơ user và số dư ví. **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Response 200:

```json
{
  "id": "0192f3a4-7c1e-7b3a-9d2e-4f5a6b7c8d9e",
  "public_id": "10284731",
  "username": "Player_7c8d9e",
  "avatar_url": null,
  "auth_provider": "guest",
  "trust_level": 0,
  "region_id": "VN",
  "referral_code": "K7Q2MX",
  "wallet": { "available_coin": "1000", "pending_coin": "0" },
  "active_boost": { "multiplier": 2, "expires_at": "2026-10-14T09:30:00.000Z" },
  "welcome": { "coin": 10000, "claimed": true, "mode": "instant" }
}
```

- `username`: username mật khẩu (lowercase) nếu có; nếu không là tên hiển thị suy ra từ id: `Player_` + 6 ký tự hex cuối của id.
- `avatar_url`: hiện luôn `null`.
- `public_id`: như trong response đăng nhập.
- `wallet.available_coin` / `pending_coin`: **string** (bigint), parse bằng số nguyên lớn. `pending_coin` là coin đang chờ xác nhận, chưa dùng được.
- `welcome`: coin chào mừng. `claimed`: tài khoản đã nhận chưa; `coin`: số đã nhận (hoặc số sẽ nhận nếu chưa); `mode`: như `welcome_mode` ở `GET /auth/login-offers`. Khi `!claimed && mode = "link_required"` → hiện banner "Link Google to claim".
- `active_boost`: boost thưởng đọc đang chạy (giải "×2 boost" của Lucky Spin), hoặc `null`. Trong khoảng này, thưởng đọc chương được nhân `multiplier`.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.
- `404 USER_NOT_FOUND`.

### `GET /me/stats`

Ba chỉ số ở màn hồ sơ. **Auth:** Bearer. **Headers:** không bắt buộc.

Response 200:

```json
{ "chapters_read": 48, "reading_seconds": 43200, "checkin_streak": 4 }
```

- `chapters_read`: số chương đã đọc hết (cùng tiêu chí hoàn thành dùng để thưởng chương), tính trên mọi truyện, mọi thời điểm.
- `reading_seconds`: tổng thời gian đọc do server đo qua heartbeat. App tự định dạng ("12h").
- `checkin_streak`: số ngày điểm danh liên tiếp, bằng `days_claimed` của `GET /checkin/state`.

Lỗi: chỉ các lỗi chung.

### `GET /me/preferences` · `PUT /me/preferences`

Thể loại yêu thích (màn chọn thể loại khi onboarding và trong cài đặt), dùng cho hàng `for_you` ở `GET /novels/home`. **Auth:** Bearer. **Headers:** không bắt buộc.

`PUT` body — thay **toàn bộ** danh sách:

```json
{ "category_ids": ["0192f7a0-0000-7000-8000-000000000001", "0192f7a0-0000-7000-8000-000000000002"] }
```

| Field          | Kiểu     | Ràng buộc                                                                                   |
| -------------- | -------- | ------------------------------------------------------------------------------------------- |
| `category_ids` | string[] | 0–5 UUID, lấy từ `id` của `GET /novels/categories`. Trùng lặp được bỏ. Mảng rỗng = xoá hết. |

Response 200 (cả `GET` lẫn `PUT`):

```json
{ "category_ids": ["0192f7a0-0000-7000-8000-000000000001"] }
```

- `GET` trả `[]` khi user chưa chọn. Thể loại đã bị ẩn sau khi chọn sẽ tự biến mất khỏi danh sách.

Lỗi:

- `400 VALIDATION_ERROR` — quá 5 phần tử hoặc không phải UUID.
- `400 CATEGORY_NOT_FOUND` — có id không tồn tại hoặc thể loại đang ẩn. Không lưu gì.
- `429 RATE_LIMITED` — quá 10 lần `PUT`/phút.

## 3. Hộp thư (Inbox)

Object `InboxMessage`:

```json
{
  "id": "0192f3b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  "type": "redemption_delivered",
  "title": "Reward ready",
  "body": "Your redemption reward is ready to view.",
  "payload": {
    "redemption_id": "0192f3af-0000-7000-8000-000000000001",
    "catalog_item_id": "0192f3af-0000-7000-8000-000000000002"
  },
  "read_at": null,
  "created_at": "2026-10-14T08:30:00.000Z"
}
```

- `type`: string tự do; hiện server chỉ tạo `redemption_delivered`. `payload` free-form theo `type` (mặc định `{}`); với `redemption_delivered` dùng `redemption_id` để gọi `GET /redemptions/{id}/code` lấy mã quà — mã **không bao giờ** nằm trong inbox.
- `title`/`body` hiện là tiếng Anh cố định (không theo `Accept-Language`).
- `read_at`: ISO hoặc `null` (chưa đọc).

### `GET /inbox`

Liệt kê tin nhắn của user, mới nhất trước, phân trang bằng cursor. **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Query:

| Field    | Type    | Bắt buộc | Ràng buộc                                  |
| -------- | ------- | -------- | ------------------------------------------ |
| `cursor` | string  | Không    | UUID; lấy từ `next_cursor` của trang trước |
| `limit`  | integer | Không    | 1-100, mặc định 20                         |

Response 200:

```json
{
  "items": [
    {
      "id": "0192f3b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
      "type": "redemption_delivered",
      "title": "Reward ready",
      "body": "Your redemption reward is ready to view.",
      "payload": {
        "redemption_id": "0192f3af-0000-7000-8000-000000000001",
        "catalog_item_id": "0192f3af-0000-7000-8000-000000000002"
      },
      "read_at": null,
      "created_at": "2026-10-14T08:30:00.000Z"
    }
  ],
  "next_cursor": null,
  "unread_count": 1
}
```

- `next_cursor`: `null` khi hết trang. `unread_count`: tổng số tin chưa đọc của user (toàn bộ, không chỉ trang hiện tại) — dùng cho badge.

Lỗi:

- `400 VALIDATION_ERROR` — `cursor` không phải UUID, `limit` ngoài 1-100, thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.

### `GET /inbox/:id`

Lấy chi tiết một tin nhắn (không tự đánh dấu đã đọc). **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Params: `id` — UUID.

Response 200: `InboxMessage`.

Lỗi:

- `400 VALIDATION_ERROR` — `id` không phải UUID, thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.
- `404 NOT_FOUND` — không tồn tại hoặc thuộc user khác.

### `POST /inbox/:id/read`

Đánh dấu tin nhắn đã đọc. **Auth:** Bearer. **Headers:** `X-App-Version`, `X-Device-Id`, `Accept-Language`.

Params: `id` — UUID. Không có body.

Response 200: `InboxMessage` với `read_at` đã được set.

- Idempotent: gọi lại trên tin đã đọc trả về `read_at` gốc (lần đọc đầu), không cập nhật.

Lỗi:

- `400 VALIDATION_ERROR` — `id` không phải UUID, thiếu header.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED`.
- `404 NOT_FOUND` — không tồn tại hoặc thuộc user khác.

## 4. Truyện (Novel)

Quy ước chung cho mọi endpoint trong mục 4:

- Mọi route đều được đăng ký ở **cả** đường dẫn gốc lẫn tiền tố `/v1` (ví dụ `/novels/home` và `/v1/novels/home` là một). App nên dùng `/v1`.
- **Tất cả** route truyện đều **bắt buộc** đăng nhập (`createAuthGuard`): header `Authorization: Bearer <access_token>`. Không có route nào đọc truyện ẩn danh hay xác thực "tuỳ chọn".
- Các route truyện **không** yêu cầu header `x-app-version` / `x-device-id` / `accept-language` (khác với mục 5).
- Format lỗi chung: `{ "error": { "code": "...", "message": "...", ...các field public } }`. Lỗi validate schema (sai UUID, sai kiểu, vượt `maximum`...) luôn là `400 VALIDATION_ERROR`.
- Lỗi chung cho mọi route (không lặp lại ở từng endpoint):
  - `401 UNAUTHORIZED` — thiếu header `Authorization: Bearer ...`.
  - `401 INVALID_ACCESS_TOKEN` — access token sai/hết hạn → gọi refresh.
  - `401 SESSION_REVOKED` — phiên đã bị thu hồi, hoặc tài khoản không còn ở trạng thái `active` (bị suspend/ban) → đăng xuất.
  - `404 USER_NOT_FOUND` — user trong token không tồn tại.
  - `403 ACCOUNT_BLOCKED` — tài khoản bị ban.
  - Thực tế tài khoản bị suspend/ban nhận `401 SESSION_REVOKED` từ bước kiểm tra token trước; các mã `403 ACCOUNT_BLOCKED` / `UNLOCK_BLOCKED` / `EARNING_BLOCKED` / `EARNING_SUSPENDED` chỉ là phòng hờ.
  - `429 RATE_LIMITED` — vượt rate limit của route (chỉ những route có ghi rate limit).
- **Hiển thị theo vùng (region/visibility):** user chỉ thấy truyện có `status = published` **và** (`regions` rỗng = mọi nơi, **hoặc** `regions` chứa `country_code` hoặc `region_id` của user). Chương chỉ hiển thị khi `status = published` và `publish_at` đã tới (hoặc null). Truyện/chương không được cấp phép cho vùng của user, chưa xuất bản hoặc không tồn tại đều trả **cùng một** lỗi 404 (`NOVEL_NOT_FOUND` / `CHAPTER_NOT_FOUND`) — server cố ý không phân biệt.
- **`cover_url`:** chuỗi URL tuyệt đối dùng thẳng được (ảnh upload qua CMS được lưu trên object storage SeaweedFS/S3 với dạng `<public_base_url>/<key>`; admin cũng có thể nhập một URL ngoài). `null` khi truyện chưa có ảnh bìa → app hiển thị ảnh placeholder.
- **Cấu hình thưởng đọc** theo region (`reading_wpm`, `min_read_ratio`, `chapter_reward_coin`, `chapter_reward_daily_cap`, `completion_scroll_ratio`...) được trả trong `GET /config` → `features.novel`.

### Object dùng chung: `NovelSummary`

```json
{
  "id": "0192f7a0-1c2d-7e3f-8a9b-0c1d2e3f4a5b",
  "slug": "dau-pha-thuong-khung",
  "title": "Đấu Phá Thương Khung",
  "author": "Thiên Tàm Thổ Đậu",
  "cover_url": "https://cdn.example.com/novel-covers/0192f7a0.jpg",
  "description": "Thiếu niên thiên tài Tiêu Viêm...",
  "completion_status": "completed",
  "tags": ["tu-tien", "huyen-huyen"],
  "categories": [
    { "id": "0192f7a0-0000-7000-8000-000000000001", "slug": "tien-hiep", "name": "Tiên Hiệp" }
  ],
  "chapter_count": 1648,
  "word_count": 5300000,
  "updated_at": "2026-10-12T08:15:00.000Z",
  "language": "vi",
  "rating": 4.8,
  "read_count": 1200000,
  "ai_generated": true,
  "editor_reviewed": true
}
```

- `author`, `cover_url`, `description` có thể `null`.
- `language`: ngôn ngữ gốc của truyện (ISO 639-1, ví dụ `vi`, `en`, `zh`).
- `rating`: điểm 0–5 (1 chữ số thập phân) do biên tập viên nhập trong CMS; `null` = chưa chấm, ẩn sao.
- `read_count`: số user khác nhau có lần tương tác đầu tiên với truyện là mở một chương (người thêm vào tủ sách trước khi đọc sẽ không được tính).
- `ai_generated` / `editor_reviewed`: hiển thị nhãn "AI-generated · editor reviewed".
- `completion_status`: `ongoing` | `completed` | `hiatus`.
- `categories` chỉ gồm thể loại đang active, đã sắp theo `sort_order`.
- `chapter_count`, `word_count` là số tổng do server tính; `updated_at` là ISO-8601 UTC.

---

### `GET /novels/home`

Dữ liệu trang chủ truyện: nổi bật, mới cập nhật, phổ biến, đọc tiếp. **Auth:** Bearer

Request: không có tham số.

Response `200`:

```json
{
  "featured": [{ "...": "NovelSummary" }],
  "latest": [{ "...": "NovelSummary" }],
  "popular": [{ "...": "NovelSummary" }],
  "for_you": [{ "...": "NovelSummary" }],
  "continue_reading": [
    {
      "novel": { "...": "NovelSummary" },
      "last_chapter_no": 57,
      "last_chapter_title": "Chương 57: Tái ngộ",
      "last_read_at": "2026-10-13T14:02:11.000Z"
    }
  ]
}
```

- `featured`: tối đa 10, truyện được admin đánh dấu nổi bật, theo `featured_rank`.
- `latest`: tối đa 10, theo `updated_at` giảm dần.
- `popular`: tối đa 10, theo số user khác nhau đã bắt đầu đọc (gửi heartbeat lần đầu) một chương của truyện trong **7 ngày** gần nhất.
- `for_you`: tối đa 10, truyện thuộc thể loại user đã chọn (`PUT /me/preferences`) mà user **chưa từng tương tác** (chưa mở chương nào và chưa từng thêm vào tủ sách), nhiều người đọc nhất trước. Khi user chưa chọn thể loại hoặc không còn truyện phù hợp, trả đúng danh sách `popular`.
- `continue_reading`: tối đa 5, những truyện user đã mở chương gần nhất (kể cả không nằm trong tủ sách). `last_chapter_no` là chương đã **mở** gần nhất (được ghi khi gọi `GET /novels/:id/chapters/:chapter_no`). `last_chapter_title` là tiêu đề của chương đó (`null` nếu chương đã bị xoá).
- Không phân trang.

Lỗi: chỉ các lỗi chung.

---

### `GET /novels`

Danh sách / tìm kiếm / lọc truyện, phân trang. **Auth:** Bearer

Request (query):

| Tham số             | Kiểu                                 | Bắt buộc | Ràng buộc / ghi chú                                                                                                                                            |
| ------------------- | ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`                 | string                               | không    | ≤ 100 ký tự. Tìm theo chuỗi con trong tiêu đề + tên khác (`alt_titles`) + tác giả; không phân biệt hoa thường **và không dấu** ("tien hiep" khớp "Tiên Hiệp"). |
| `category`          | string                               | không    | ≤ 80 ký tự. **Slug** của thể loại (lấy từ `GET /novels/categories`).                                                                                           |
| `tag`               | string                               | không    | ≤ 80 ký tự. Khớp chính xác một phần tử của `tags`.                                                                                                             |
| `completion_status` | `ongoing` \| `completed` \| `hiatus` | không    |                                                                                                                                                                |
| `language`          | string                               | không    | 2–10 ký tự. Ngôn ngữ gốc của truyện, khớp chính xác `language` trong `NovelSummary` (vd. `vi`, `en`).                                                          |
| `sort`              | `updated` \| `new` \| `popular`      | không    | Mặc định `updated` (mới cập nhật). `new` = mới xuất bản; `popular` = nhiều user đã tương tác nhất (mở chương hoặc thêm vào tủ sách, kể cả đã bỏ khỏi tủ).      |
| `cursor`            | string                               | không    | Chuỗi số 1–6 chữ số, lấy nguyên từ `next_cursor` của trang trước. Không gửi ở trang đầu.                                                                       |
| `limit`             | integer                              | không    | 1–50, mặc định 20.                                                                                                                                             |

Response `200`:

```json
{
  "items": [{ "...": "NovelSummary" }],
  "next_cursor": "20",
  "total": 134
}
```

- `total`: tổng số truyện khớp bộ lọc trên **mọi** trang (dùng cho dòng "134 kết quả"); giống nhau ở mọi trang của cùng một truy vấn.

- `next_cursor`: `null` khi hết dữ liệu. Thực chất là offset (không phải keyset) — app chỉ cần coi là chuỗi mờ và gửi lại y nguyên. Khi dữ liệu thay đổi giữa hai trang có thể bị trùng/sót một vài truyện.

Lỗi: chỉ các lỗi chung (`400 VALIDATION_ERROR` khi `cursor` sai định dạng, `limit` > 50...).

---

### `GET /novels/categories`

Danh sách thể loại đang active. **Auth:** Bearer

Request: không có tham số.

Response `200`:

```json
{
  "items": [
    { "id": "0192f7a0-0000-7000-8000-000000000001", "slug": "tien-hiep", "name": "Tiên Hiệp" },
    { "id": "0192f7a0-0000-7000-8000-000000000002", "slug": "ngon-tinh", "name": "Ngôn Tình" }
  ]
}
```

- Sắp theo `sort_order` rồi `name`. Không phân trang. Không lọc theo region (một thể loại có thể không có truyện nào hiển thị được với user).

Lỗi: chỉ các lỗi chung.

---

### `GET /novels/:id`

Chi tiết một truyện kèm chính sách VIP và trạng thái thư viện của user. **Auth:** Bearer

Request (params):

| Tham số | Kiểu          | Bắt buộc | Ràng buộc |
| ------- | ------------- | -------- | --------- |
| `id`    | string (UUID) | có       | id truyện |

Response `200` (= `NovelSummary` + các field sau):

```json
{
  "id": "0192f7a0-1c2d-7e3f-8a9b-0c1d2e3f4a5b",
  "slug": "dau-pha-thuong-khung",
  "title": "Đấu Phá Thương Khung",
  "author": "Thiên Tàm Thổ Đậu",
  "cover_url": "https://cdn.example.com/novel-covers/0192f7a0.jpg",
  "description": "Thiếu niên thiên tài Tiêu Viêm...",
  "completion_status": "completed",
  "tags": ["tu-tien"],
  "categories": [
    { "id": "0192f7a0-0000-7000-8000-000000000001", "slug": "tien-hiep", "name": "Tiên Hiệp" }
  ],
  "chapter_count": 1648,
  "word_count": 5300000,
  "updated_at": "2026-10-12T08:15:00.000Z",
  "language": "vi",
  "rating": 4.8,
  "read_count": 1200000,
  "ai_generated": false,
  "editor_reviewed": false,
  "alt_titles": ["Battle Through the Heavens"],
  "translator": "Nhóm dịch ABC",
  "vip_from_chapter": 101,
  "default_unlock_coin": 50,
  "allow_ad_unlock": true,
  "share_url": "https://ainovel.app/n/dau-pha-thuong-khung",
  "library": {
    "in_bookshelf": true,
    "last_chapter_no": 57,
    "last_read_at": "2026-10-13T14:02:11.000Z"
  }
}
```

- `vip_from_chapter`: từ chương số này trở đi mặc định là VIP; `null` = không có VIP mặc định. **Lưu ý:** từng chương có thể bị admin ghi đè VIP/không VIP và giá riêng → luôn dựa vào `is_vip` / `unlock_price` trong mục lục, không tự suy ra từ field này.
- `default_unlock_coin`: giá mở khoá mặc định (coin) cho chương VIP không có giá riêng.
- `allow_ad_unlock`: truyện có cho mở chương VIP bằng quảng cáo hay không.
- `share_url`: link chia sẻ truyện. **Có thể không có** (field bị bỏ hẳn chứ không phải `null`) khi server chưa cấu hình base URL (hoặc base URL không phải https) — khi đó app chia sẻ tiêu đề truyện.
- `library`: `in_bookshelf=false`, `last_*=null` nếu user chưa từng tương tác.

Lỗi:

- `404 NOVEL_NOT_FOUND` — truyện không tồn tại, chưa xuất bản, hoặc không được cấp phép ở vùng của user.

---

### `GET /novels/:id/chapters`

Mục lục (TOC) có phân trang keyset theo `chapter_no`, kèm trạng thái VIP/đã mở/đã nhận thưởng. **Auth:** Bearer

Request:

| Tham số | Vị trí | Kiểu          | Bắt buộc | Ràng buộc / ghi chú                                               |
| ------- | ------ | ------------- | -------- | ----------------------------------------------------------------- |
| `id`    | params | string (UUID) | có       | id truyện                                                         |
| `after` | query  | integer       | không    | ≥ 0. Trả các chương có `chapter_no > after`. Mặc định 0 (từ đầu). |
| `limit` | query  | integer       | không    | 1–500, mặc định 100.                                              |

Response `200`:

```json
{
  "items": [
    {
      "id": "0192f7b1-aaaa-7bbb-8ccc-000000000064",
      "chapter_no": 100,
      "title": "Chương 100: Đột phá",
      "word_count": 3120,
      "is_vip": false,
      "unlock_price": 0,
      "ad_unlock": false,
      "unlocked": true,
      "rewarded": true
    },
    {
      "id": "0192f7b1-aaaa-7bbb-8ccc-000000000065",
      "chapter_no": 101,
      "title": "Chương 101: Dị hoả",
      "word_count": 2980,
      "is_vip": true,
      "unlock_price": 50,
      "ad_unlock": true,
      "unlocked": false,
      "rewarded": false
    }
  ],
  "next_after": 101
}
```

- `id` của chương (UUID) là thứ dùng cho `POST /novels/chapters/:id/unlock` và `POST /novels/read-heartbeat`; `chapter_no` dùng cho `GET /novels/:id/chapters/:chapter_no`.
- `is_vip`: đã tính cả ghi đè theo chương lẫn `vip_from_chapter`.
- `unlock_price`: giá coin để mở; luôn `0` với chương không VIP.
- `ad_unlock`: `true` khi chương là VIP **và** truyện cho phép mở bằng quảng cáo.
- `unlocked`: `true` với chương free, hoặc chương VIP user đã mở (bằng coin hoặc ad). Mở khoá là vĩnh viễn.
- `rewarded`: user đã nhận coin thưởng đọc chương này chưa (mỗi chương chỉ thưởng 1 lần).
- `next_after`: `chapter_no` cuối của trang; gửi làm `after` để lấy trang tiếp. `null` = hết.
- `chapter_no` có thể không liên tục (chương chưa xuất bản bị ẩn).

Lỗi:

- `404 NOVEL_NOT_FOUND` — như `GET /novels/:id`.

---

### `GET /novels/:id/chapters/:chapter_no`

Đọc nội dung một chương; đồng thời ghi "đọc tới đâu" vào lịch sử. **Auth:** Bearer

**Rate limit (theo user):** 20 request/phút **và** 300 request/giờ → vượt thì `429 RATE_LIMITED`. App không nên prefetch hàng loạt chương.

Request (params):

| Tham số      | Kiểu          | Bắt buộc | Ràng buộc     |
| ------------ | ------------- | -------- | ------------- |
| `id`         | string (UUID) | có       | id truyện     |
| `chapter_no` | integer       | có       | 1 – 1.000.000 |

Response `200`:

```json
{
  "id": "0192f7b1-aaaa-7bbb-8ccc-000000000064",
  "novel_id": "0192f7a0-1c2d-7e3f-8a9b-0c1d2e3f4a5b",
  "chapter_no": 100,
  "title": "Chương 100: Đột phá",
  "content": "Đoạn văn thứ nhất...\n\nĐoạn văn thứ hai...",
  "word_count": 3120,
  "is_vip": false,
  "prev_chapter_no": 99,
  "next_chapter_no": 101,
  "reward": {
    "eligible": true,
    "coin": 10,
    "required_seconds": 312,
    "read_seconds": 0,
    "rewarded": false
  }
}
```

- `content`: plain text, các đoạn cách nhau bằng **một dòng trống** (`\n\n`), không có markup.
- `prev_chapter_no` / `next_chapter_no`: chương hiển thị liền trước/sau (`null` nếu không có). Chương kế có thể là VIP chưa mở → khi mở sẽ nhận `CHAPTER_LOCKED`.
- `reward.eligible`: `false` với chương VIP, hoặc khi region tắt thưởng đọc (`enabled=false` hoặc `chapter_reward_coin=0`).
- `reward.coin`: mức thưởng cơ bản khi hoàn thành chương (0 với VIP), **chưa nhân boost**; số thực nhận = `coin × boost_multiplier` (xem heartbeat). Chỉ có ý nghĩa khi `eligible = true`.
- `reward.required_seconds`: thời gian đọc tối thiểu (giây) do server tính từ `word_count`: `ceil(word_count / reading_wpm × 60 × min_read_ratio)`, kẹp trong `[min_read_seconds, max_read_seconds]` (mặc định 300 wpm, 50%, 30s–900s).
- `reward.read_seconds`: thời gian đọc đã được server ghi nhận trước đó cho chương này (để tiếp tục progress bar).
- `reward.rewarded`: đã nhận thưởng chương này chưa.
- Side-effect: cập nhật `last_chapter_no` / `last_read_at` của truyện trong thư viện (tạo bản ghi lịch sử nếu chưa có; **không** tự thêm vào tủ sách).

Lỗi:

- `404 CHAPTER_NOT_FOUND` — chương không tồn tại/chưa xuất bản, hoặc truyện không hiển thị với vùng của user.
- `403 CHAPTER_LOCKED` — chương VIP mà user chưa mở. Body có thêm thông tin để hiển thị popup mở khoá:

  ```json
  {
    "error": {
      "code": "CHAPTER_LOCKED",
      "message": "This chapter must be unlocked first",
      "chapter_id": "0192f7b1-aaaa-7bbb-8ccc-000000000065",
      "unlock_price": 50,
      "ad_unlock": true,
      "preview": {
        "title": "Chương 101: Cửa ải",
        "text": "Đoạn mở đầu thứ nhất…\n\nĐoạn thứ hai…"
      }
    }
  }
  ```

  `chapter_id` dùng ngay cho `POST /novels/chapters/:id/unlock`; `unlock_price` là giá coin; `ad_unlock` = truyện có cho mở bằng quảng cáo không.
  `preview`: phần mở đầu để hiển thị phía trên popup mở khoá — tiêu đề chương và 2 đoạn đầu (cách nhau bằng `\n\n`), tối đa 800 ký tự; nếu bị cắt thì cắt ở ranh giới từ và kết thúc bằng `…`. Chỉ có ở endpoint này; `CHAPTER_LOCKED` từ heartbeat/unlock không kèm `preview`.

- `429 RATE_LIMITED` — vượt 20 chương/phút (chờ vài giây rồi thử lại).
- `429 CHAPTER_HOURLY_LIMIT` — vượt 300 chương/giờ. Body có thêm `retry_at` (ISO 8601) — thời điểm được đọc tiếp, dùng cho màn "đọc quá nhanh" với đồng hồ đếm ngược:

  ```json
  {
    "error": {
      "code": "CHAPTER_HOURLY_LIMIT",
      "message": "…",
      "retry_at": "2026-10-14T09:20:00.000Z"
    }
  }
  ```

---

### `POST /novels/chapters/:id/unlock`

Mở khoá vĩnh viễn một chương VIP bằng coin hoặc bằng một quảng cáo thưởng đã được xác minh. **Auth:** Bearer

**Rate limit (theo user):** 30 request/phút.

Request:

| Tham số     | Vị trí | Kiểu               | Bắt buộc             | Ràng buộc / ghi chú                                                                                                                                       |
| ----------- | ------ | ------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | params | string (UUID)      | có                   | **id chương** (không phải id truyện, không phải `chapter_no`)                                                                                             |
| `method`    | body   | `"coin"` \| `"ad"` | có                   |                                                                                                                                                           |
| `intent_id` | body   | string (UUID)      | có khi `method="ad"` | `intent_id` lấy từ `POST /earning/rewarded-ad/intent` với `placement="chapter_unlock"`, **sau khi** đã xem xong quảng cáo. Bị bỏ qua khi `method="coin"`. |

Body ví dụ:

```json
{ "method": "coin" }
```

```json
{ "method": "ad", "intent_id": "0192f7c3-1111-7222-8333-444455556666" }
```

Response `200`:

```json
{
  "chapter_id": "0192f7b1-aaaa-7bbb-8ccc-000000000065",
  "unlocked": true,
  "method": "coin",
  "coin_spent": 50,
  "new_balance": "1250"
}
```

- `method`: `coin` | `ad` | `free`. `free` = chương vốn không VIP → không trừ gì, trả về ngay.
- **Idempotent:** nếu chương đã được mở trước đó, gọi lại trả `200` với `method` và `coin_spent` **của lần mở ban đầu**, không trừ thêm (an toàn để retry).
- `coin_spent`: coin đã trừ (luôn `0` với `ad`/`free`; có thể `0` với `coin` nếu chương có giá 0).
- `new_balance`: số dư `available` của ví sau thao tác, kiểu **string** (bigint).
- Một intent quảng cáo chỉ mở được **một** chương. Intent không gắn với chương cụ thể — có thể dùng cho bất kỳ chương VIP nào (cho phép ad) của chính user.

Lỗi:

- `404 CHAPTER_NOT_FOUND` — chương không tồn tại/không hiển thị với user.
- `403 UNLOCK_BLOCKED` — tài khoản không ở trạng thái `active`.
- `400 INSUFFICIENT_BALANCE` — (`method=coin`) không đủ coin; không có gì bị ghi nhận.
- `400 AD_UNLOCK_DISABLED` — (`method=ad`) truyện không cho mở bằng quảng cáo.
- `403 AD_NOT_VERIFIED` — (`method=ad`) intent không hợp lệ cho thao tác này: chưa được AdMob SSV xác nhận (còn `pending`), sai placement (không phải `chapter_unlock`), thuộc user khác, hoặc đã được dùng (mở chương khác / dùng cho spin). Server cố ý trả một mã duy nhất. Trường hợp đáng retry là SSV về chậm hơn app → retry vài lần với backoff (xem luồng bên dưới).
- `500 INTERNAL_ERROR` — (`method=ad`) `intent_id` đúng định dạng UUID nhưng **không tồn tại** trong DB (vi phạm khoá ngoại); hoặc hai request mở cùng một chương chạy đồng thời. Không phải lỗi app cần xử lý riêng; gọi lại sẽ ra kết quả đúng (idempotent).
- `429 RATE_LIMITED` — vượt 30 lần/phút.

---

### `POST /novels/read-heartbeat`

Nhịp báo "đang đọc" để server tự đo thời gian đọc và trả thưởng coin khi hoàn thành chương free. **Auth:** Bearer

**Rate limit (theo user):** 20 request/phút (nhịp ~10s = 6/phút, dư cho retry/đổi chương).

Request (body):

| Field          | Kiểu          | Bắt buộc | Ràng buộc / ghi chú                                                                                                                              |
| -------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chapter_id`   | string (UUID) | có       | id chương đang hiển thị                                                                                                                          |
| `scroll_ratio` | number        | có       | 0–1. Vị trí cuộn hiện tại (0 = đầu chương, 1 = cuối chương). Server giữ giá trị **lớn nhất** từng gửi, nên cuộn ngược lên không làm mất tiến độ. |

```json
{ "chapter_id": "0192f7b1-aaaa-7bbb-8ccc-000000000064", "scroll_ratio": 0.42 }
```

Response `200`:

```json
{
  "read_seconds": 140,
  "required_seconds": 312,
  "scroll_ratio": 0.42,
  "reward_eligible": true,
  "boost_multiplier": 1,
  "rewarded": false,
  "credited_coin": 0,
  "new_balance": "1250",
  "daily_remaining": 17
}
```

- `read_seconds`: tổng thời gian đọc **do server đo** cho chương này (đây là con số dùng để quyết định thưởng, không phải đồng hồ của app).
- `required_seconds`: ngưỡng thời gian cần đạt (cùng công thức với `reward.required_seconds`).
- `scroll_ratio`: max scroll server đã ghi nhận.
- `reward_eligible`: chương có thể trả thưởng không (`false` với VIP hoặc khi region tắt thưởng).
- `boost_multiplier`: `1` bình thường; `> 1` khi user đang có boost (xem `active_boost` ở `GET /me`). Thưởng chương = `chapter_reward_coin × boost_multiplier`, tính tại nhịp trả thưởng.
- `rewarded`: `true` **đúng một lần** — ở nhịp vừa cộng coin. App dùng field này để chạy animation thưởng. Các nhịp sau trên cùng chương trả `false`.
- `credited_coin`: số coin cộng ở nhịp này (0 nếu không cộng).
- `new_balance`: số dư `available` hiện tại (string), có ở mọi nhịp.
- `daily_remaining`: số chương còn được thưởng trong ngày (theo múi giờ region).

Quy tắc server (chống gian lận):

- **Chỉ một chương "đang đọc" mỗi user**: mỗi nhịp đánh dấu chương đó là chương active (Redis, TTL 60s). Thời gian chỉ được cộng khi nhịp trước đó của user cũng thuộc **chính chương này** và cách không quá 60s. Gửi nhịp xen kẽ nhiều chương → không chương nào được cộng.
- **Nhịp đầu tiên** trên một chương (hoặc nhịp đầu sau khi đổi chương / sau khoảng lặng > 60s) chỉ đặt mốc, **không** cộng thời gian.
- Mỗi nhịp cộng `round(thời gian server giữa hai nhịp)`, **tối đa 30 giây/nhịp**. App bị đưa xuống nền rồi quay lại sẽ không được cộng cả khoảng thời gian đó.
- **Khoảng cách khuyến nghị: ~10 giây/nhịp** (chỉ gửi khi màn hình đọc đang ở foreground). Không gửi nhanh hơn ~3s/nhịp vì sẽ đụng rate limit.
- **Điều kiện trả thưởng** (kiểm tra ở mỗi nhịp): `reward_eligible` **và** chương chưa từng được thưởng **và** `read_seconds ≥ required_seconds` **và** `scroll_ratio ≥ completion_scroll_ratio` (mặc định 0.9) **và** `daily_remaining > 0`. Đủ cả → cộng `chapter_reward_coin` vào ví `available` ngay trong nhịp đó.
- **Trần ngày:** `chapter_reward_daily_cap` chương/ngày (mặc định 20), ngày tính theo múi giờ của region. Hết trần thì vẫn ghi nhận tiến độ, chỉ không cộng coin.
- Chương VIP đã mở vẫn được ghi tiến độ nhưng **không bao giờ** được thưởng coin.
- Các trạng thái "chưa đủ", "đã thưởng", "hết trần", "region tắt thưởng" đều trả `200` — app đọc `rewarded`, không dựa vào status code.

Lỗi:

- `403 EARNING_BLOCKED` / `403 EARNING_SUSPENDED` — tài khoản không đủ điều kiện kiếm coin → dừng gửi heartbeat.
- `404 CHAPTER_NOT_FOUND` — chương không tồn tại/không hiển thị.
- `403 CHAPTER_LOCKED` — chương VIP chưa mở (payload như ở `GET` chương).
- `429 UNBACKED_CAP_EXCEEDED` — user đã chạm trần coin "không có doanh thu bảo chứng" 20.000 coin / 30 ngày (tính chung với check-in, task, welcome...). Chỉ xảy ra ở nhịp **sắp** cộng thưởng; cả nhịp bị huỷ (thời gian của nhịp đó cũng không được ghi).
- `429 MINT_PAUSED` — hệ thống tạm dừng phát coin miễn phí cho region. Xử lý như trên.
- `429 RATE_LIMITED` — vượt 20 nhịp/phút.

---

### `GET /library`

Tủ sách hoặc lịch sử đọc của user. **Auth:** Bearer

Request (query):

| Tham số | Kiểu                     | Bắt buộc | Ràng buộc / ghi chú                                                                                                                                                                                                           |
| ------- | ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`  | `bookshelf` \| `history` | không    | Mặc định `bookshelf`. `bookshelf` = truyện đang trong tủ, sắp theo lần gần nhất user thêm vào tủ hoặc mở chương của truyện đó; `history` = truyện đã từng mở chương (theo `last_read_at` giảm dần), kể cả không nằm trong tủ. |
| `limit` | integer                  | không    | 1–100, mặc định 50.                                                                                                                                                                                                           |

Response `200`:

```json
{
  "items": [
    {
      "novel": { "...": "NovelSummary" },
      "in_bookshelf": true,
      "last_chapter_no": 57,
      "last_chapter_title": "Chương 57: Tái ngộ",
      "last_read_at": "2026-10-13T14:02:11.000Z"
    }
  ]
}
```

- Không phân trang (không có cursor) — chỉ trả tối đa `limit` bản ghi.
- `last_chapter_title`: tiêu đề chương mở gần nhất, `null` nếu chưa mở chương nào hoặc chương đã bị xoá.
- Truyện không còn hiển thị với vùng của user bị loại khỏi danh sách.

Lỗi: chỉ các lỗi chung.

---

### `PUT /library/:id`

Thêm truyện vào tủ sách (idempotent). **Auth:** Bearer

Request (params): `id` — string (UUID), id truyện, bắt buộc. Không có body.

Response `200`:

```json
{ "novel_id": "0192f7a0-1c2d-7e3f-8a9b-0c1d2e3f4a5b", "in_bookshelf": true }
```

Lỗi:

- `404 NOVEL_NOT_FOUND` — truyện không tồn tại/không hiển thị với user.

---

### `DELETE /library/:id`

Bỏ truyện khỏi tủ sách (idempotent; lịch sử đọc vẫn giữ). **Auth:** Bearer

Request (params): `id` — string (UUID), id truyện, bắt buộc.

Response `200`:

```json
{ "novel_id": "0192f7a0-1c2d-7e3f-8a9b-0c1d2e3f4a5b", "in_bookshelf": false }
```

- Luôn trả `200` kể cả khi truyện không có trong tủ hoặc không tồn tại (không kiểm tra visibility).

Lỗi: chỉ các lỗi chung.

---

### Luồng đọc truyện nhận coin

1. (Một lần khi mở app) `GET /config` → đọc `features.novel` để biết region có bật thưởng đọc không, `chapter_reward_coin`, `chapter_reward_daily_cap`, `completion_scroll_ratio`.
2. Duyệt truyện: `GET /novels/home`, `GET /novels?…`, `GET /novels/:id`.
3. `GET /novels/:id/chapters` → hiển thị mục lục với badge VIP (`is_vip`, `unlocked`) và dấu "đã nhận thưởng" (`rewarded`). Lưu `id` (UUID) của từng chương.
4. Mở chương: `GET /novels/:id/chapters/:chapter_no`.
   - `403 CHAPTER_LOCKED` → chuyển sang luồng mở khoá (coin hoặc quảng cáo), xong gọi lại bước 4.
   - `200` → hiển thị `content`; nếu `reward.eligible && !reward.rewarded` thì hiện progress thưởng với `read_seconds / required_seconds`.
5. Ngay khi màn hình đọc hiển thị, gửi `POST /novels/read-heartbeat { chapter_id, scroll_ratio }` (nhịp đầu chỉ đặt mốc), rồi tiếp tục **mỗi ~10 giây** khi app ở foreground. Gửi `scroll_ratio` hiện tại (0–1).
6. Dừng heartbeat khi app vào nền / tắt màn hình / rời màn hình đọc; khi quay lại thì gửi tiếp (nhịp đầu sau khoảng nghỉ > 60s lại chỉ đặt mốc). Chỉ gửi heartbeat cho **một** chương tại một thời điểm.
7. Cập nhật UI từ response: progress = `read_seconds / required_seconds`, `scroll_ratio`, `daily_remaining`.
8. Khi một nhịp trả `rewarded: true` → chạy animation `+credited_coin`, cập nhật số dư bằng `new_balance`. Có thể ngừng hiển thị progress thưởng cho chương này (các nhịp sau vẫn được, nhưng không cần thiết cho thưởng).
9. Nếu `reward_eligible=false` hoặc `daily_remaining=0` → ẩn progress thưởng (có thể giãn/ngừng heartbeat; tiến độ "đã đọc" vẫn được lưu nếu tiếp tục gửi).
10. Lỗi heartbeat: `403 EARNING_*` → dừng hẳn; `429 UNBACKED_CAP_EXCEEDED` / `MINT_PAUSED` → báo người dùng "tạm hết lượt nhận coin", dừng heartbeat cho chương này; `429 RATE_LIMITED` → giãn nhịp; lỗi mạng → bỏ qua, nhịp sau tự bù (tối đa 30s/nhịp).
11. Sang chương: dùng `next_chapter_no` → quay lại bước 4.

---

## 5. Quảng cáo thưởng (Rewarded ads)

Quy ước chung:

- Cả hai route đều có ở đường dẫn gốc và `/v1`.
- **Auth:** Bearer (bắt buộc).
- **Header bắt buộc** (validate bằng schema, thiếu → `400 VALIDATION_ERROR`, kiểm tra trước cả auth): `x-app-version`, `x-device-id`, `accept-language` (chuỗi không rỗng).
- **Placement** (vị trí quảng cáo — mỗi placement có quota/cooldown riêng nếu region cấu hình):

| `placement`      | Mục đích                   | Phần thưởng                                                                                                                                 |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `earncoin`       | Xem ad nhận coin           | Coin được cộng server-side khi SSV về                                                                                                       |
| `checkin`        | Ad x2 điểm danh            | SSV **không** cộng coin; intent được dùng ở `POST /checkin/double`                                                                          |
| `luckyspin`      | Ad để được quay vòng quay  | Intent được dùng ở `POST /spin` (`intent_id`). SSV **cũng cộng coin** theo `coin_multiplier` của placement (seed mặc định 1.0)              |
| `chapter_unlock` | Ad mở khoá chương VIP      | Intent được dùng ở `POST /novels/chapters/:id/unlock` với `method="ad"`. Coin theo `coin_multiplier` (seed 0, nên mặc định không cộng coin) |
| _(bỏ trống)_     | Build cũ chưa có placement | Dùng quota chung của region, cộng coin khi SSV về                                                                                           |

- Số coin cho một ad (khi có) = `floor(est_ecpm_usd/1000 × COIN_PER_USD × 20% × coin_multiplier)`, kẹp trong `[5, coin_cap]`; `coin_multiplier = 0` thì không cộng coin. App **không** tự tính, chỉ đọc lại số dư ví.
- Chỉ `checkin` bị server ép 0 coin. Mọi placement khác cộng coin theo `coin_multiplier`; placement mà region không cấu hình thì dùng hệ số 1.
- Quota theo placement: nếu region không cấu hình riêng placement đó thì dùng `daily_cap`/`cooldown_s` chung của region (mặc định 20 ad/ngày, cooldown 30s), nhưng việc **đếm** vẫn tính riêng theo placement đã gửi.
- **Xác nhận server-side (AdMob SSV):** phần thưởng không bao giờ do app báo về; Google gọi thẳng callback SSV (có chữ ký ECDSA) về server để xác nhận đã xem xong. Để SSV khớp được với intent, trên ad request AdMob app **phải** đặt `ServerSideVerificationOptions.customData = ssv_custom_data` (chính là `intent_id`) — thiếu `customData` thì callback bị bỏ qua và **không** có thưởng; và **nên** đặt `ServerSideVerificationOptions.userId = <user id của tài khoản>` (claim `sub` trong access token) — field này tuỳ chọn, nhưng nếu gửi mà khác chủ của intent thì phần thưởng bị huỷ.
- Mỗi intent sống **10 phút**: phải xem ad và SSV phải về trong 10 phút, quá hạn thì intent hết hiệu lực.

---

### `GET /earning/rewarded-ad/state`

Trạng thái quota/cooldown quảng cáo thưởng của user (để bật/tắt nút "Xem quảng cáo"). **Auth:** Bearer

Request:

| Tham số           | Vị trí | Kiểu                                                       | Bắt buộc | Ràng buộc / ghi chú                            |
| ----------------- | ------ | ---------------------------------------------------------- | -------- | ---------------------------------------------- |
| `Authorization`   | header | string                                                     | có       | `Bearer <access_token>`                        |
| `x-app-version`   | header | string                                                     | có       | không rỗng                                     |
| `x-device-id`     | header | string                                                     | có       | không rỗng                                     |
| `accept-language` | header | string                                                     | có       | không rỗng                                     |
| `placement`       | query  | `checkin` \| `earncoin` \| `luckyspin` \| `chapter_unlock` | không    | Không gửi = quota chung (đếm mọi ad của user). |

Response `200`:

```json
{
  "enabled": true,
  "placement": "chapter_unlock",
  "daily_cap": 10,
  "rewards_today": 3,
  "pending_rewards": 1,
  "rewards_remaining": 6,
  "cooldown_s": 30,
  "next_available_at": "2026-10-14T09:31:05.000Z",
  "reset_at": "2026-10-14T17:00:00.000Z"
}
```

- `enabled`: region có bật rewarded ads không. `false` → ẩn nút (tạo intent sẽ bị `404 FEATURE_DISABLED`).
- `placement`: echo placement đã hỏi, `null` nếu không gửi.
- `daily_cap`: trần ad/ngày áp dụng cho placement này.
- `rewards_today`: số ad đã được SSV xác nhận hôm nay (theo placement).
- `pending_rewards`: số intent tạo hôm nay chưa được xác nhận và chưa hết hạn — chúng **giữ chỗ** trong quota.
- `rewards_remaining` = `max(0, daily_cap − rewards_today − pending_rewards)`.
- `cooldown_s`: thời gian chờ tối thiểu giữa hai lần tạo intent (tính từ lúc **tạo intent**, không phải lúc xem xong).
- `next_available_at`: thời điểm được tạo intent tiếp theo; `null` = được tạo ngay.
- `reset_at`: thời điểm quota reset (nửa đêm theo múi giờ region), ISO-8601 UTC.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header bắt buộc hoặc `placement` không hợp lệ.
- `403 EARNING_BLOCKED` — tài khoản bị ban.
- `403 EARNING_SUSPENDED` — tài khoản tạm khoá kiếm coin.
- `404 USER_NOT_FOUND`.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED` — như lỗi auth chung.

---

### `POST /earning/rewarded-ad/intent`

Tạo một "intent" (nonce dùng một lần) trước khi hiển thị quảng cáo thưởng; giữ một suất trong quota. **Auth:** Bearer

Request:

| Tham số           | Vị trí | Kiểu                                                       | Bắt buộc | Ràng buộc / ghi chú                                                          |
| ----------------- | ------ | ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `Authorization`   | header | string                                                     | có       | `Bearer <access_token>`                                                      |
| `x-app-version`   | header | string                                                     | có       | không rỗng                                                                   |
| `x-device-id`     | header | string                                                     | có       | không rỗng                                                                   |
| `accept-language` | header | string                                                     | có       | không rỗng                                                                   |
| `placement`       | body   | `checkin` \| `earncoin` \| `luckyspin` \| `chapter_unlock` | không    | Body có thể bỏ trống hoàn toàn (build cũ). Build mới nên luôn gửi placement. |

```json
{ "placement": "chapter_unlock" }
```

Response `200`:

```json
{
  "intent_id": "0192f7c3-1111-7222-8333-444455556666",
  "ssv_custom_data": "0192f7c3-1111-7222-8333-444455556666",
  "state": {
    "enabled": true,
    "placement": "chapter_unlock",
    "daily_cap": 10,
    "rewards_today": 3,
    "pending_rewards": 2,
    "rewards_remaining": 5,
    "cooldown_s": 30,
    "next_available_at": "2026-10-14T09:31:35.000Z",
    "reset_at": "2026-10-14T17:00:00.000Z"
  }
}
```

- `intent_id`: dùng cho API tiêu thụ intent (`unlock` với `method="ad"`, spin...). Hết hạn sau 10 phút.
- `ssv_custom_data`: giá trị **phải** gán vào `customData` của `ServerSideVerificationOptions` trên ad request AdMob (hiện bằng `intent_id`, nhưng app nên dùng field này).
- `state`: trạng thái quota **sau khi** đã giữ chỗ cho intent này (`pending_rewards` +1, `rewards_remaining` −1, `next_available_at` = bây giờ + `cooldown_s`).
- Không tạo intent "dự phòng": intent chưa dùng vẫn chiếm quota và kích hoạt cooldown cho tới khi hết hạn (10 phút).

Lỗi:

- `400 VALIDATION_ERROR` — thiếu header bắt buộc hoặc `placement` không hợp lệ.
- `403 EARNING_BLOCKED` / `403 EARNING_SUSPENDED` — tài khoản không đủ điều kiện.
- `404 USER_NOT_FOUND`.
- `404 FEATURE_DISABLED` — region chưa bật rewarded ads.
- `429 DAILY_CAP_REACHED` — `rewards_remaining = 0` (tính cả intent đang pending).
- `429 COOLDOWN_ACTIVE` — chưa hết cooldown kể từ intent trước cùng placement (không gửi `placement` thì tính từ intent gần nhất của **mọi** placement); dùng `next_available_at` từ `GET /earning/rewarded-ad/state` để đếm ngược.
- `401 UNAUTHORIZED` / `INVALID_ACCESS_TOKEN` / `SESSION_REVOKED` — như lỗi auth chung.

---

### Luồng mở khoá chương VIP bằng quảng cáo

1. App nhận `403 CHAPTER_LOCKED` khi mở chương (hoặc thấy `is_vip && !unlocked` trong mục lục). Lấy `chapter_id`, `unlock_price`, `ad_unlock` từ payload lỗi / mục lục.
2. Nếu `ad_unlock = false` → chỉ hiển thị lựa chọn mở bằng coin (`POST /novels/chapters/:id/unlock { "method": "coin" }`).
3. (Tuỳ chọn, để bật/tắt nút) `GET /earning/rewarded-ad/state?placement=chapter_unlock` → chỉ cho bấm "Xem quảng cáo để mở" khi `enabled && rewards_remaining > 0 && next_available_at == null`.
4. Người dùng bấm → `POST /earning/rewarded-ad/intent { "placement": "chapter_unlock" }` → nhận `intent_id`, `ssv_custom_data`. Xử lý `429 DAILY_CAP_REACHED` / `COOLDOWN_ACTIVE` / `404 FEATURE_DISABLED` bằng thông báo phù hợp.
5. Load rewarded ad AdMob (ad unit dành cho chapter_unlock), đặt `ServerSideVerificationOptions` với `customData = ssv_custom_data` và `userId = <user id>` **trước khi** show.
6. Show ad. Chỉ tiếp tục khi nhận callback `onUserEarnedReward` (người dùng xem đủ). Nếu người dùng đóng sớm → không gọi unlock (intent sẽ tự hết hạn sau 10 phút, vẫn chiếm quota tới lúc đó).
7. Google gọi SSV về server → server đánh dấu intent là `consumed` (có thể kèm cộng coin, tuỳ cấu hình `coin_multiplier` của placement). App không thấy bước này.
8. App gọi `POST /novels/chapters/{chapter_id}/unlock { "method": "ad", "intent_id": "<intent_id>" }`.
9. Nếu `403 AD_NOT_VERIFIED`: SSV thường về chậm vài giây so với app → retry với backoff (ví dụ 1s, 2s, 4s, 8s… tổng ~30–60s, trong giới hạn 30 request/phút). Nếu vẫn thất bại → báo lỗi "Chưa xác nhận được quảng cáo, vui lòng thử lại" (intent không dùng được nữa nếu đã quá 10 phút).
10. `200` với `method: "ad"` → gọi lại `GET /novels/:id/chapters/:chapter_no` để hiển thị nội dung, cập nhật `unlocked=true` trong mục lục local. Từ đây chương mở vĩnh viễn; nếu chương VIP này được đọc tiếp thì heartbeat vẫn ghi tiến độ nhưng không thưởng coin.
11. Mỗi intent chỉ mở **một** chương; muốn mở chương khác phải xem ad mới (lặp lại từ bước 4).

> **Quy ước chung cho các mục 6–13**
>
> - Mọi route bên dưới được mount **hai lần**: ở gốc (`/wallet`) và dưới tiền tố `/v1` (`/v1/wallet`). Hai đường dẫn hoạt động như nhau.
> - **Auth: Bearer** nghĩa là cần header `Authorization: Bearer <access_token>`. Thiếu header hoặc header không bắt đầu bằng `Bearer ` sẽ trả `401 UNAUTHORIZED`; token sai hoặc hết hạn trả `401 INVALID_ACCESS_TOKEN`; session đã bị thu hồi (logout hoặc revoke) trả `401 SESSION_REVOKED`.
> - **App headers** (`AppHeadersSchema`) là bắt buộc trên hầu hết route: `X-App-Version`, `X-Device-Id`, `Accept-Language` (string, không rỗng). Thiếu một trong ba sẽ trả `400 VALIDATION_ERROR`. Route nào không yêu cầu sẽ được ghi rõ.
> - Body lỗi luôn có dạng `{"error": {"code": "...", "message": "..."}}`. Một số lỗi có thêm field public cùng cấp với `code` (ví dụ `claimable_at` của `REDEMPTION_HOLD_ACTIVE`).
> - Lỗi schema (sai kiểu, thiếu field, vượt min/max) trả `400 VALIDATION_ERROR`.
> - **Số coin:** số dư và số tiền đọc từ DB (`available_coin`, `amount`, `balance_after`, `new_balance`, `coin_price`, `total_earned_coin`…) là **string** (bigint). Phần thưởng lấy từ config (`credited_coin`, `reward_coin`, `rewards[]`, `amount_coin`…) là **number**. Client nên parse string thành số nguyên 64-bit hoặc BigDecimal, không dùng float.
> - Rate limit theo user là fixed window trên Redis. Khi vượt giới hạn trả `429 RATE_LIMITED`. Không có header `Retry-After`.
> - **Không có endpoint nào trong phần này đọc header `Idempotency-Key`.** Chống trùng được làm phía server (theo ngày, theo intent), hoặc qua field `idempotency_key` trong body (chỉ có ở `POST /earning/coin`).
> - Các lỗi chung khi cộng coin "unbacked" (check-in, task, free spin, direct coin): `429 UNBACKED_CAP_EXCEEDED` (đã chạm trần 20.000 coin miễn phí trong 30 ngày cuộn) và `429 MINT_PAUSED` (kill-switch của region đang bật).

## 6. Ví & lịch sử coin

Ví có hai bucket:

- **available**: coin dùng được ngay (đổi quà, mở chương…).
- **pending**: coin đang bị giữ (offerwall hoặc referral có thời gian hold). Job `hold-release` chạy định kỳ để chuyển sang available khi `hold_until` đã qua. Nếu account bị suspend hoặc ban, coin vẫn nằm ở pending cho tới khi account được mở lại.

### `GET /wallet`

Lấy số dư ví hiện tại. **Auth:** Bearer. **Headers:** App headers.

Request: không có tham số.

Response `200`:

```json
{
  "available_coin": "12500",
  "pending_coin": "3000",
  "lifetime_earned": "48200",
  "next_pending_release_at": "2026-10-16T03:21:09.000Z"
}
```

- 3 field coin là **string** (bigint).
- `next_pending_release_at`: thời điểm sớm nhất một khoản đang chờ trở thành dùng được (dòng "available in 2 days" dưới số pending); `null` nếu không có khoản nào đang chờ có hạn. Khoản bị đóng băng chờ duyệt không được tính. Giá trị có thể đã ở quá khứ (job release chưa chạy, hoặc tài khoản đang bị suspend/ban): khi đó app hiện "Sắp khả dụng" thay vì đếm ngược âm.
- `lifetime_earned` là tổng mọi khoản đã cộng (cả available lẫn pending), không bị giảm khi tiêu coin.

Lỗi:

- `401 UNAUTHORIZED / INVALID_ACCESS_TOKEN / SESSION_REVOKED`: lỗi auth.
- `404 WALLET_NOT_FOUND`: user chưa có ví (bất thường).

### `GET /wallet/ledger`

Lịch sử biến động coin, mới nhất trước, phân trang bằng cursor. **Auth:** Bearer. **Headers:** App headers.

Query:

| Tên        | Kiểu                                                                   | Bắt buộc | Ràng buộc / ghi chú                                                                                                |
| ---------- | ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `limit`    | integer                                                                | không    | 1–100, mặc định 20                                                                                                 |
| `cursor`   | string                                                                 | không    | Lấy từ `next_cursor` của trang trước (là `id` của ledger entry, UUIDv7).                                           |
| `provider` | `"tapjoy"` \| `"pubscale"` \| `"adgate"` \| `"adjoe"` \| `"appsprize"` | không    | Chỉ lấy các entry gắn với earning event của network này (dùng cho màn "Lịch sử offerwall").                        |
| `bucket`   | `"pending"`                                                            | không    | Chỉ lấy coin **đang chờ** (tab "Pending"), mọi nguồn: offerwall, giới thiệu… Entry đã release không còn xuất hiện. |

Response `200`:

```json
{
  "items": [
    {
      "id": "01929f3a-7c2e-7b1a-9f00-2b6c1d1e9a01",
      "entry_type": "OFFERWALL_CREDIT",
      "entry_label": "Offer reward",
      "amount": "2500",
      "bucket": "pending",
      "balance_after": "12500",
      "note": null,
      "created_at": "2026-10-14T03:21:09.000Z",
      "available_at": "2026-10-17T03:21:09.000Z",
      "offerwall": {
        "provider": "tapjoy",
        "provider_label": "Tapjoy",
        "transaction_id": "a1b2c3d4",
        "status": "pending",
        "available_at": "2026-10-17T03:21:09.000Z"
      }
    },
    {
      "id": "01929f2b-1111-7c3d-8e00-000000000002",
      "entry_type": "CHECKIN_CREDIT",
      "entry_label": "Daily check-in",
      "amount": "20",
      "bucket": "available",
      "balance_after": "12500",
      "note": "Daily check-in day 3",
      "created_at": "2026-10-14T01:00:00.000Z",
      "available_at": null,
      "offerwall": null
    }
  ],
  "next_cursor": "01929f2b-1111-7c3d-8e00-000000000002"
}
```

Ghi chú:

- `amount` là **string có dấu**: khoản cộng thì dương, khoản trừ (`*_DEBIT`, `*_CLAWBACK`, dòng HOLD_RELEASE phía pending) thì **âm**, ví dụ `"-5000"`.
- `balance_after` luôn là số dư **available** sau entry, kể cả khi entry thuộc bucket `pending`. Vì vậy với entry pending, `balance_after` không đổi so với entry trước.
- `bucket`: `"available"` hoặc `"pending"`.
- `available_at`: với mọi entry **đang chờ** (offerwall, giới thiệu…), thời điểm dự kiến coin dùng được; `null` khi đã dùng được, đã release, hoặc đang bị đóng băng chờ duyệt (khi đó app hiện "Đang xét duyệt"). Có thể đã ở quá khứ, xử lý như `next_pending_release_at`.
- `entry_label` là nhãn tiếng Anh do server sinh ra. Client mới nên hiển thị field này thay vì tự map `entry_type`. Loại không biết sẽ có nhãn `"Coin activity"`.
- `offerwall` chỉ khác `null` với `OFFERWALL_CREDIT` / `OFFERWALL_CLAWBACK`:
  - `status`: `"reversed"` (clawback), `"pending"` (đang hold, khi đó `available_at` = thời điểm dự kiến release), `"available"` (đã release hoặc được cộng thẳng). Sau khi hold được release, entry gốc chuyển sang `status: "available"`, còn `bucket` của entry gốc **vẫn là `"pending"`** vì ledger là append-only. Nếu offer bị network thu hồi khi còn đang hold, entry gốc cũng hiện `status: "available"` (`available_at = null`) dù coin chưa từng dùng được; việc thu hồi nằm ở dòng `OFFERWALL_CLAWBACK` riêng (`status: "reversed"`).
  - `transaction_id`: mã giao dịch của network, có thể `null`.
- `next_cursor = null` nghĩa là hết dữ liệu.

Các `entry_type` client có thể gặp (kèm `entry_label`):

| entry_type               | entry_label            | Dấu | Ghi chú                                                                               |
| ------------------------ | ---------------------- | --- | ------------------------------------------------------------------------------------- |
| `OFFERWALL_CREDIT`       | Offer reward           | +   | Thường vào `pending`, sau đó được release                                             |
| `OFFERWALL_CLAWBACK`     | Offer reversed         | −   | Network thu hồi                                                                       |
| `REWARDED_AD_CREDIT`     | Ad reward              | +   | Xem rewarded ad (AdMob SSV)                                                           |
| `DRAMA_WATCH_CREDIT`     | Episode reward         | +   | Legacy                                                                                |
| `CHECKIN_CREDIT`         | Daily check-in         | +   |                                                                                       |
| `TASK_CREDIT`            | Task reward            | +   |                                                                                       |
| `REFERRAL_CREDIT`        | Referral bonus         | +   | Có thể vào `pending`                                                                  |
| `REFERRAL_CLAWBACK`      | Referral reversed      | −   |                                                                                       |
| `SPIN_TICKET_DEBIT`      | Spin ticket            | −   | Legacy (spin giờ trả bằng ad, không trừ coin)                                         |
| `SPIN_PRIZE_CREDIT`      | Spin prize             | +   |                                                                                       |
| `FREE_SPIN_PRIZE_CREDIT` | Daily free spin prize  | +   |                                                                                       |
| `EPISODE_UNLOCK_DEBIT`   | Episode unlock         | −   | Legacy                                                                                |
| `REDEMPTION_DEBIT`       | Redemption             | −   | Đổi quà                                                                               |
| `REDEMPTION_REFUND`      | Redemption refunded    | +   | Đơn đổi quà bị reject hoặc fail                                                       |
| `ADMIN_ADJUSTMENT`       | Adjustment             | ±   |                                                                                       |
| `HOLD_RELEASE`           | Pending released       | ±   | Luôn đi thành cặp: một dòng `-X` ở bucket pending và một dòng `+X` ở bucket available |
| `WELCOME_CREDIT`         | Welcome bonus          | +   |                                                                                       |
| `LOGIN_BIND_CREDIT`      | Account linked bonus   | +   |                                                                                       |
| `DIRECT_CREDIT`          | Coin reward            | +   | `POST /earning/coin`                                                                  |
| `NOVEL_READ_CREDIT`      | Chapter reading reward | +   |                                                                                       |
| `CHAPTER_UNLOCK_DEBIT`   | Chapter unlock         | −   |                                                                                       |
| `CHECKIN_BONUS_CREDIT`   | Check-in bonus         | +   | `POST /checkin/double`                                                                |

Lỗi:

- `400 VALIDATION_ERROR`: `limit` ngoài khoảng 1–100, `provider` không hợp lệ, hoặc `bucket` khác `"pending"`.
- `401` lỗi auth.
- Lưu ý: `cursor` không được validate format. Truyền chuỗi không phải UUID có thể gây `500 INTERNAL_ERROR`, nên chỉ dùng giá trị `next_cursor` server trả về.

## 7. Điểm danh

Ngày được tính theo timezone của **region của user** (`users.region_id`, không phụ thuộc IP hay VPN). Reset vào 00:00 giờ địa phương của region (`reset_at`, biểu diễn bằng UTC). Bảng thưởng `rewards[]` đánh số theo ngày 1..N và lặp lại sau ngày cuối. Bỏ lỡ một ngày thì streak quay về ngày 1.

> **x2 bằng quảng cáo:** sau khi claim, app có thể cho xem rewarded ad placement `checkin` rồi gọi `POST /checkin/double` để nhận thêm đúng bằng thưởng điểm danh hôm nay. SSV callback của placement `checkin` không tự cộng coin.

### `GET /checkin/state`

Trạng thái check-in để render thẻ điểm danh. **Auth:** Bearer. **Headers:** App headers.

Request: không có tham số.

Response `200`:

```json
{
  "enabled": true,
  "streak_day": 3,
  "days_claimed": 2,
  "today_claimed": false,
  "rewards": [10, 15, 20, 25, 30, 40, 100],
  "next_reward_coin": 20,
  "reset_at": "2026-10-14T17:00:00.000Z",
  "bonus_coin": 20,
  "bonus_claimed_today": false
}
```

- `enabled: false` nghĩa là region tắt check-in, nên ẩn thẻ. Endpoint này **không** trả 404 khi tắt.
- `streak_day`: ngày (1..N, đã quay vòng) mà lần claim _hiện tại_ rơi vào. Nếu hôm nay đã claim thì đây là ngày của hôm nay, nếu chưa thì là ngày mà claim ngay bây giờ sẽ nhận. **Dùng field này để highlight**, không tự suy ra từ `days_claimed`.
- `days_claimed`: số ngày liên tiếp đã được cộng, không quay vòng. Account mới bằng 0.
- `next_reward_coin`: số coin của lần claim kế tiếp. Nếu hôm nay chưa claim thì đây là phần thưởng hôm nay, nếu đã claim thì là phần thưởng ngày mai (giả định streak không đứt).
- `rewards[]`, `next_reward_coin`: kiểu number.
- `bonus_coin`: số coin `POST /checkin/double` sẽ cộng (= thưởng điểm danh của hôm nay). `bonus_claimed_today`: hôm nay đã nhận x2 chưa. Hiện nút "Watch a video to double it" khi `today_claimed && !bonus_claimed_today`.

Lỗi:

- `401` lỗi auth.
- `403 EARNING_BLOCKED`: account bị ban.
- `403 EARNING_SUSPENDED`: account bị suspend.
- `404 USER_NOT_FOUND`.

### `POST /checkin/claim`

Nhận thưởng điểm danh hôm nay. Coin vào bucket `available`. **Auth:** Bearer. **Headers:** App headers. **Rate limit:** 10 request/60s/user.

Request: không có body.

Response `200`:

```json
{
  "credited_coin": 20,
  "new_balance": "12520",
  "streak_day": 3
}
```

- `credited_coin` là number. `new_balance` (available sau khi cộng) là string.

Lỗi:

- `401` lỗi auth.
- `403 EARNING_BLOCKED` / `403 EARNING_SUSPENDED`.
- `404 FEATURE_DISABLED`: region tắt check-in.
- `404 USER_NOT_FOUND` / `404 WALLET_NOT_FOUND`.
- `409 ALREADY_CLAIMED`: hôm nay đã claim, kể cả khi hai request song song tới cùng lúc.
- `429 RATE_LIMITED`: vượt 10 lần/phút.
- `429 UNBACKED_CAP_EXCEEDED` / `429 MINT_PAUSED`.

### `POST /checkin/double`

Nhận thưởng x2 điểm danh sau khi xem rewarded ad. Coin vào `available`, ghi thành `CHECKIN_BONUS_CREDIT`. **Auth:** Bearer. **Headers:** App headers. **Rate limit:** 10 request/60s/user.

Luồng:

1. `POST /checkin/claim` thành công (hoặc `today_claimed = true`).
2. `POST /earning/rewarded-ad/intent { "placement": "checkin" }` → `intent_id`, `ssv_custom_data`.
3. Show AdMob rewarded ad với `customData = ssv_custom_data`. Chờ `onUserEarnedReward`.
4. `POST /checkin/double { "intent_id": "…" }`. Nếu `403 AD_NOT_VERIFIED` thì SSV chưa về: retry với backoff (1s, 2s, 4s…, tối đa ~30–60s).

Body:

```json
{ "intent_id": "0192f7c3-1111-7222-8333-444455556666" }
```

Response `200`:

```json
{ "credited_coin": 20, "new_balance": "12540" }
```

Lỗi:

- `400 VALIDATION_ERROR`: `intent_id` không phải UUID.
- `401` lỗi auth.
- `403 AD_NOT_VERIFIED`: intent không tồn tại, không thuộc user, chưa được SSV xác nhận (nên retry), sai placement (không phải `checkin`), hoặc đã dùng.
- `403 EARNING_BLOCKED` / `403 EARNING_SUSPENDED`.
- `404 FEATURE_DISABLED`: region tắt check-in.
- `409 CHECKIN_NOT_CLAIMED`: hôm nay chưa claim điểm danh.
- `404 USER_NOT_FOUND` / `404 WALLET_NOT_FOUND`.
- `409 ALREADY_CLAIMED`: hôm nay đã nhận x2 (intent không bị tiêu).
- `429 RATE_LIMITED`. Thưởng x2 (`CHECKIN_BONUS_CREDIT`) có quảng cáo bảo chứng nên **không** bị `UNBACKED_CAP_EXCEEDED` / `MINT_PAUSED`.

## 8. Nhiệm vụ

Danh sách nhiệm vụ lấy từ config region (`region_config.features.tasks`). Mỗi nhiệm vụ claim được **1 lần/ngày**, reset lúc 00:00 theo timezone của region. Có hai nhóm:

- **Nhiệm vụ có tiến độ** (server tự đo, chỉ claim được khi `progress >= target`):
  - `read_minutes`: số phút đọc hôm nay (thời gian đọc do server đo qua `POST /novels/read-heartbeat`); `target` là số phút.
  - `finish_chapters`: số chương hoàn thành **lần đầu** trong hôm nay (đủ thời gian đọc tối thiểu + cuộn đạt `completion_scroll_ratio` của region, kể cả chương VIP đã mở). Đọc lại chương đã hoàn thành trước đó không được tính.
  - `watch_videos`: số rewarded ad đã được SSV xác nhận hôm nay, mọi placement.
- **Nhiệm vụ một lần** (`invite_friend`, `share_app`, `daily_login`): claim là **tự khai báo**: client gửi "tôi đã làm" và server trả coin, không kiểm tra hành động thật.

Nhiệm vụ loại `watch_ad` (một lần, tự khai báo) bị server lọc bỏ vì ad đã được trả qua SSV.

### `GET /earning/tasks`

Danh sách nhiệm vụ hôm nay. **Auth:** Bearer. **Headers:** App headers.

Response `200`:

```json
{
  "tasks": [
    {
      "id": "share_app_daily",
      "title": "Share the app",
      "description": "Share AINovel with a friend",
      "reward_coin": 30,
      "completed_today": false,
      "task_type": "share_app",
      "icon_url": "https://cdn.example.com/tasks/share.png",
      "action": "ainovel://share",
      "status": "available",
      "progress": 0,
      "target": 1
    }
  ],
  "reset_at": "2026-10-14T17:00:00.000Z"
}
```

- `task_type`: `invite_friend` | `share_app` | `daily_login` | `read_minutes` | `finish_chapters` | `watch_videos`. (`watch_ad` không bao giờ xuất hiện vì đã bị lọc.)
- `status`:
  - `"in_progress"`: nhiệm vụ có tiến độ chưa đạt `target`; nút claim bị khoá (UI hiện "Go"/"Watch").
  - `"available"`: claim được.
  - `"completed"`: đã claim hôm nay (= `completed_today`).
- `progress` / `target`:
  - Nhiệm vụ có tiến độ: `progress` là giá trị hôm nay, đã kẹp tối đa bằng `target`. Ví dụ "Read for 10 minutes" → `progress: 6, target: 10`.
  - Nhiệm vụ một lần: `progress` là 0 hoặc 1, `target` = 1.
  - Tiến độ không tự claim: app vẫn gọi `POST /earning/tasks/claim` khi `status = "available"`.
- `icon_url`, `action` có thể `null`. Khi null, app dùng icon hoặc fallback có sẵn. `action` là deep link trong app (ví dụ `ainovel://spin`), không phải URL HTTP.
- `reward_coin` là number.

Lỗi:

- `401` lỗi auth.
- `403 EARNING_BLOCKED` / `403 EARNING_SUSPENDED`.
- `404 FEATURE_DISABLED`: region chưa bật tasks. Khác với check-in, ở đây trả 404 chứ không trả `enabled:false`.
- `404 USER_NOT_FOUND`.

### `POST /earning/tasks/claim`

Nhận thưởng một nhiệm vụ. Coin vào `available`. **Auth:** Bearer. **Headers:** App headers. **Rate limit:** 20 request/60s/user.

Body:

| Field     | Kiểu   | Bắt buộc | Ràng buộc                                       |
| --------- | ------ | -------- | ----------------------------------------------- |
| `task_id` | string | có       | 1–64 ký tự, là `id` lấy từ `GET /earning/tasks` |

```json
{ "task_id": "share_app_daily" }
```

Response `200`:

```json
{
  "task_id": "share_app_daily",
  "credited_coin": 30,
  "new_balance": "12550"
}
```

Lỗi:

- `400 VALIDATION_ERROR`: thiếu hoặc sai `task_id`.
- `401` lỗi auth.
- `403 EARNING_BLOCKED` / `403 EARNING_SUSPENDED`.
- `404 FEATURE_DISABLED`: region chưa bật tasks.
- `404 USER_NOT_FOUND` / `404 WALLET_NOT_FOUND`.
- `404 NOT_FOUND`: `task_id` không tồn tại, hoặc là task `watch_ad`.
- `409 TASK_NOT_COMPLETE`: nhiệm vụ có tiến độ chưa đạt `target`.
- `409 ALREADY_CLAIMED`: task đã hoàn thành hôm nay.
- `429 RATE_LIMITED` / `429 UNBACKED_CAP_EXCEEDED` / `429 MINT_PAUSED`.

## 9. Nhận coin trực tiếp

Tính năng "cộng coin theo số do client gửi lên", bật hoặc tắt toàn cục trong CMS (superadmin). Server không xác minh nguồn của số coin này. Giới hạn chỉ gồm: công tắc on/off, trần mỗi request (`max_amount_coin`), trần unbacked 20.000/30 ngày và kill-switch. Ghi vào ledger là `DIRECT_CREDIT`.

### `GET /earning/coin/state`

Kiểm tra tính năng có bật không và trần mỗi request, để ẩn hoặc hiện entry point. **Auth:** Bearer. **Headers:** App headers.

Response `200`:

```json
{ "enabled": true, "max_amount_coin": 500 }
```

- `max_amount_coin`: integer (number).

Lỗi:

- `401` lỗi auth.

### `POST /earning/coin`

Cộng `amount_coin` vào ví `available` của chính user. **Auth:** Bearer. **Headers:** App headers. **Rate limit:** 5 request/60s/user.

Body:

| Field             | Kiểu    | Bắt buộc | Ràng buộc                                                                                                                                                                         |
| ----------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount_coin`     | integer | có       | 1–10.000.000 theo schema. Trần thật là `max_amount_coin` (kiểm tra ở service).                                                                                                    |
| `idempotency_key` | string  | không    | 8–128 ký tự. Nên gửi (ví dụ UUID sinh 1 lần cho mỗi hành động): retry với cùng key chỉ cộng 1 lần. Không gửi thì mỗi lần retry là một lần cộng mới. Key được namespace theo user. |

```json
{ "amount_coin": 100, "idempotency_key": "7f1c2a9e-5d4b-4c1a-9e2f-0a1b2c3d4e5f" }
```

Response `200`:

```json
{ "amount_coin": 100, "new_balance": "12650", "deduped": false }
```

- Khi request bị trùng `idempotency_key` thì `deduped: true` và **`amount_coin: 0`**. `new_balance` lúc đó là số dư ghi tại lần cộng gốc, không phải số dư hiện tại.

Lỗi:

- `400 VALIDATION_ERROR`: `amount_coin` không phải số nguyên, < 1 hoặc > 10.000.000, hoặc `idempotency_key` sai độ dài.
- `400 AMOUNT_TOO_LARGE`: `amount_coin > max_amount_coin`.
- `401` lỗi auth.
- `403 EARNING_BLOCKED` / `403 EARNING_SUSPENDED`.
- `404 FEATURE_DISABLED`: tính năng đang tắt.
- `404 USER_NOT_FOUND` / `404 WALLET_NOT_FOUND`.
- `429 RATE_LIMITED` / `429 UNBACKED_CAP_EXCEEDED` / `429 MINT_PAUSED`.

## 10. Offerwall

Offerwall chạy bằng **SDK Android của network** (Tapjoy, PubScale…). Backend không trả danh sách offer cụ thể và không có URL để mở. Backend chỉ cho biết region đang bật network nào và `placement` dùng để mở offerwall trong SDK. Coin được cộng khi network gọi postback server-to-server về backend. App không gọi API nào để nhận coin offerwall.

**Định danh user truyền cho SDK:** dùng **`id` của user**, tức UUID lấy từ `GET /me` → `id` (trùng với claim `sub` trong access token). Server tra `users.id` bằng đúng giá trị network gửi lại:

- **Tapjoy**: đặt làm User ID của Tapjoy (`setUserID`). Giá trị này quay về postback dưới tên `snuid`.
- **PubScale**: đặt làm `user_id` khi khởi tạo hoặc mở offerwall. Giá trị này quay về postback dưới tên `user_id`.
- Nếu truyền sai (ví dụ device id, username, referral code), postback bị ghi nhận `user_not_found` và user **không nhận được coin**.

Sau khi user hoàn thành offer: coin = payout USD × 10.000 × tỉ lệ chia theo trust level. Coin thường vào bucket **pending** với thời gian hold do cấu hình từng network (offer giá trị cao có thể hold lâu hơn), rồi tự chuyển sang available. Theo dõi qua `GET /wallet/ledger?provider=tapjoy|pubscale` (object `offerwall.status` / `available_at`).

### `GET /offerwall/offers`

Danh sách thẻ offerwall và network khả dụng cho region. **Auth:** Không (public). Region được xác định theo **IP** của request (GeoIP), không theo `users.region_id`. **Headers:** App headers (bắt buộc).

Response `200`:

```json
{
  "enabled": true,
  "offers": [
    {
      "id": "tapjoy-main",
      "provider": "tapjoy",
      "name": "Tapjoy Offers",
      "description": "Install apps & play games to earn coins",
      "icon_url": "https://cdn.example.com/offerwall/tapjoy.png",
      "badge_text": "HOT",
      "reward_text": "Up to $15",
      "placement": "Offerwall"
    }
  ],
  "networks": [
    {
      "id": "tapjoy",
      "name": "Tapjoy",
      "icon_url": "https://cdn.example.com/offerwall/tapjoy.png",
      "placement": "Offerwall",
      "deeplink_url": null
    },
    {
      "id": "pubscale",
      "name": "PubScale",
      "icon_url": null,
      "placement": null,
      "deeplink_url": null
    }
  ]
}
```

- `enabled: false` thì `offers` và `networks` đều rỗng, nên ẩn offerwall.
- `offers[]`: thẻ launch do CMS quản lý (đã lọc theo trạng thái active, region, khung thời gian, và chỉ gồm provider đang bật cho region và có network config active). `id` là mã thẻ, `provider` là id network dùng để chọn SDK, `placement` là chuỗi truyền vào SDK của provider đó để mở offerwall.
- `networks[]`: field tương thích ngược cho client cũ. `deeplink_url` **luôn `null`** (deprecated).
- `reward_text`: dòng mức thưởng trên thẻ (vd "Up to $15"), CMS nhập tự do; `null` thì ẩn dòng này.
- `icon_url`, `placement`: thẻ không đặt thì server đã lấy từ cấu hình network; chỉ khi cả hai đều không có mới trả `null` → app dùng asset/giá trị mặc định. `badge_text` có thể `null`.

Lỗi:

- `400 VALIDATION_ERROR`: thiếu app headers.
- `500 CONFIG_NOT_FOUND`: region không có config (lỗi phía server).

## 11. Vòng quay (Spin)

**Lượt paid phải xem rewarded ad trước; lượt free mỗi ngày không cần quảng cáo.** Không trừ coin (`ticket_coin` luôn `"0"`). Luồng cho lượt paid:

1. `POST /earning/rewarded-ad/intent` với `placement: "luckyspin"` để nhận `intent_id` (TTL 10 phút, xem mục Rewarded Ads).
2. Hiển thị AdMob rewarded ad với `custom_data` = giá trị SSV do intent trả về.
3. AdMob gọi SSV callback về server, intent chuyển sang `consumed`.
4. Gọi `POST /spin` với `intent_id`. Mỗi intent chỉ dùng được **1 lần**.

Lượt free: gọi thẳng `POST /spin/free` với body `{}`.

Nếu app gọi `/spin` trước khi SSV kịp tới, server trả `403 AD_NOT_VERIFIED`. Đây là lỗi tạm thời: **retry sau vài giây** với cùng `intent_id`. Ngày reset theo timezone của config spin trong region.

### `GET /spin/state`

Trạng thái vòng quay và bảng giải. **Auth:** Bearer. **Headers:** App headers.

Response `200`:

```json
{
  "ticket_coin": "0",
  "spins_today": 3,
  "spins_remaining": 7,
  "daily_cap": 10,
  "ads_remaining": 7,
  "next_ad_available_at": null,
  "free_spin_available": true,
  "reset_at": "2026-10-14T17:00:00.000Z",
  "odds_disclosure": "Displayed odds are base odds; pity can improve high-tier odds.",
  "paid_prizes_display": [
    { "slot": 1, "type": "coin", "value": "10", "tier": "low", "label": "10 coin", "pct": 45.5 },
    { "slot": 2, "type": "coin", "value": "50", "tier": "mid", "label": "50 coin", "pct": 30 },
    { "slot": 3, "type": "coin", "value": "500", "tier": "high", "label": "500 coin", "pct": 4.5 },
    {
      "slot": 4,
      "type": "coin",
      "value": "5000",
      "tier": "jackpot",
      "label": "5,000 coin",
      "pct": 0.1
    }
  ],
  "free_prizes_display": [
    { "slot": 1, "type": "coin", "value": "20", "tier": "low", "label": "20 coin", "pct": 60 },
    { "slot": 2, "type": "coin", "value": "60", "tier": "mid", "label": "60 coin", "pct": 40 }
  ],
  "prizes_display": [
    { "slot": 1, "type": "coin", "value": "10", "tier": "low", "label": "10 coin", "pct": 45.5 }
  ],
  "active_boost": null
}
```

- `ticket_coin` luôn `"0"` (giữ lại để tương thích).
- `spins_remaining` = min(`daily_cap − spins_today`, `ads_remaining`). Đây là số lượt user thật sự còn quay được.
- `ads_remaining` / `next_ad_available_at`: quota và cooldown của placement `luckyspin`. Field sau là ISO string hoặc `null` nếu không bị cooldown.
- `free_spin_available`: hôm nay chưa quay free. Không phụ thuộc quota ad.
- `spins_today`, `daily_cap` chỉ tính lượt paid.
- `paid_prizes_display` / `free_prizes_display`: bảng giải của từng loại. `prizes_display` là alias của bảng paid dành cho client cũ. `value` là string. `pct` là xác suất cơ bản (%, làm tròn 1 chữ số thập phân). Pity có thể tăng tỉ lệ tier `high` (×3 trọng số) sau một chuỗi lượt paid không trúng high hoặc jackpot. `type` gồm `coin` | `voucher` | `boost`, `tier` gồm `low` | `mid` | `high` | `jackpot`.
- Giải `boost` có `value` dạng `"<hệ số>x<số phút>"`, ví dụ `"2x60"` = thưởng đọc ×2 trong 60 phút. `label` mặc định `"×2 boost"`.
- **Bảng giải do admin sửa trong CMS bất kỳ lúc nào** (loại giải, giá trị, tỉ lệ, số ô). Mỗi bảng có **1 đến 12 ô**; `slot` là số nguyên dương không trùng (CMS đánh liên tục từ 1). App phải vẽ vòng quay theo đúng mảng trả về (số ô, nhãn, thứ tự `slot`), không hardcode số ô hay giá trị. Nên gọi lại `GET /spin/state` mỗi lần mở màn spin.
- `label`: nhãn admin tự đặt (tối đa 40 ký tự) hoặc nhãn mặc định server sinh ra: `"<value> coin"` cho coin, `"×<hệ số> boost"` cho boost.
- Thực tế không còn giải `voucher`: CMS không cho lưu loại này cho tới khi spin hỗ trợ trả voucher. App vẫn nên xử lý `type` lạ an toàn (hiển thị `label`).
- `active_boost`: boost đang chạy `{ multiplier, expires_at }` hoặc `null` (giống `GET /me`).

Lỗi:

- `401` lỗi auth.
- `403 SPIN_SUSPENDED`: account không active hoặc fraud score cao.
- `404 FEATURE_DISABLED`: region tắt spin.
- `404 USER_NOT_FOUND`.
- `500 SPIN_CONFIG_MISSING / SPIN_CONFIG_MALFORMED / SPIN_CONFIG_EV_INVALID`: config sai (lỗi server). `message` nêu ô và luật bị sai (vd `"Slot 3: a boost is written multiplier x minutes, e.g. 2x60"`), chỉ để log, không hiển thị cho user.

### `POST /spin`

Quay lượt **paid** (trả bằng ad). Giải coin được ghi thành `SPIN_PRIZE_CREDIT`. **Auth:** Bearer. **Headers:** App headers.

Body:

| Field       | Kiểu          | Bắt buộc | Ràng buộc                                                            |
| ----------- | ------------- | -------- | -------------------------------------------------------------------- |
| `intent_id` | string (uuid) | có       | Intent `luckyspin` đã được SSV xác minh, chưa dùng, thuộc chính user |

```json
{ "intent_id": "01929fa0-1c2d-7e3f-8a9b-0c1d2e3f4a5b" }
```

Response `200`:

```json
{
  "prize_slot": 2,
  "prize_type": "coin",
  "prize_value": "50",
  "new_balance": "12700"
}
```

- `prize_slot` khớp với `slot` trong bảng giải để app dừng vòng quay đúng ô. Nếu admin vừa sửa bảng giải sau lần `GET /spin/state` gần nhất, `prize_slot` có thể không có (hoặc khác giải) trong bảng app đang giữ. Khi đó hiển thị kết quả theo `prize_type`/`prize_value` của response rồi gọi lại `GET /spin/state`.
- `prize_value` là string. Nếu giải bằng 0 coin, số dư không đổi.
- Khi trúng giải `boost`: không cộng coin, response có thêm `"boost": { "multiplier": 2, "expires_at": "…" }`. Nếu user đang có boost chạy, boost mới được **xếp hàng sau** boost hiện tại (bắt đầu khi boost cũ hết hạn), nên `expires_at` có thể xa hơn 60 phút.

Lỗi:

- `400 VALIDATION_ERROR`: `intent_id` không phải UUID.
- `401` lỗi auth.
- `403 AD_NOT_VERIFIED`: intent không tồn tại, không phải của user, chưa `consumed` (SSV chưa tới, nên retry), đã dùng rồi, hoặc placement khác `luckyspin`. Mọi trường hợp dùng chung một mã lỗi.
- `403 SPIN_SUSPENDED`.
- `404 FEATURE_DISABLED` / `404 USER_NOT_FOUND` / `404 WALLET_NOT_FOUND`.
- `429 DAILY_CAP_REACHED`: đã hết `daily_cap` lượt paid hôm nay.
- `503 SPIN_PRIZE_UNSUPPORTED`: trúng ô giải `voucher` (chưa hỗ trợ). Toàn bộ giao dịch rollback và intent **chưa** bị tiêu.
- `500 SPIN_CONFIG_*`: lỗi config.

### `POST /spin/free`

Lượt quay **free** mỗi ngày, **không cần xem quảng cáo**. Giải được ghi thành `FREE_SPIN_PRIZE_CREDIT` (unbacked). **Auth:** Bearer. **Headers:** App headers. **Rate limit:** 10 request/60s/user.

Body: không bắt buộc. Nên gửi `{}`. Nếu bỏ trống body thì **không** được gửi header `Content-Type: application/json`, nếu không server trả `400 BAD_REQUEST`. Có thể gửi `{ "intent_id": "…" }` (build cũ có xem ad trước lượt free). Nếu có `intent_id` thì intent được kiểm tra và tiêu như ở `POST /spin`.

Response giống hệt `POST /spin` (bảng giải dùng `free_prizes_display`).

Lỗi: giống `POST /spin`, chỉ khác:

- Thay `429 DAILY_CAP_REACHED` bằng `429 FREE_SPIN_ALREADY_CLAIMED`: hôm nay đã quay free.
- `403 AD_NOT_VERIFIED` chỉ xảy ra khi có gửi `intent_id`.
- Có thể gặp thêm `429 RATE_LIMITED` / `429 UNBACKED_CAP_EXCEEDED` / `429 MINT_PAUSED`.

### `GET /spin/recent-wins`

10 lượt quay gần nhất toàn hệ thống có giải loại `coin` (cả free và paid, kể cả giải 0 coin, khi đó `prize_label` là `"0 coins"`; giải boost không xuất hiện), dùng cho dải "social proof". **Auth:** Không. **Headers:** không yêu cầu.

Response `200`:

```json
{
  "wins": [
    {
      "username": "Player_3f9a1c",
      "prize_label": "500 coins",
      "prize_value": "500",
      "created_at": "2026-10-14T03:10:00.000Z"
    }
  ]
}
```

- `username` được sinh từ 6 ký tự cuối của user id (không phải username thật). `prize_label` format bằng `toLocaleString()` phía server.

Lỗi: không có lỗi nghiệp vụ.

## 12. Giới thiệu bạn bè (Referral)

Mỗi user có mã giới thiệu dạng `HP-XXXXXX` (6 ký tự từ `A–Z` và `2–9`, không có `0/O/1/I`). Người được mời (referee) nhập mã trong **72 giờ** kể từ lúc tạo account. Việc nhập mã **không** cộng coin ngay cho bên nào. Người giới thiệu (referrer) nhận `reward_pct` phần trăm coin mà referee kiếm được từ các nguồn **backed** (offerwall, rewarded ad), ghi thành `REFERRAL_CREDIT`. Khoản này chỉ bắt đầu được tính sau khi referee "qualified" (đã có welcome bonus và một offer backed ≥ $0.10), có thể bị hold vào `pending` và bị thu hồi (`REFERRAL_CLAWBACK`) khi offer gốc bị thu hồi. Phần chia có trần theo doanh thu thực của offer (không bao giờ âm) và có thể hết hạn sau số tháng cấu hình theo region (`duration_months`).

### `GET /referral` (alias: `GET /referral/stats`)

Hai path dùng chung handler và cho kết quả giống nhau. Trả mã giới thiệu, thống kê và trạng thái nhập mã của chính user. **Auth:** Bearer. **Headers:** App headers.

Response `200`:

```json
{
  "code": "HP-7KQ2MX",
  "share_url": "https://ainovel.app/r/HP-7KQ2MX",
  "total_referrals": 5,
  "qualified_referrals": 2,
  "pending_referrals": 3,
  "total_earned_coin": "1840",
  "terms": {
    "reward_pct": 0.1,
    "milestone_bonus_coin": 0,
    "milestone_bonus_threshold": 50000,
    "hold_hours": 72,
    "credit_immediately": false
  },
  "recent_activity": [{ "coin": 250, "at": "2026-10-13T09:12:00.000Z" }],
  "application": {
    "status": "eligible",
    "can_redeem": true,
    "expires_at": "2026-10-16T08:00:00.000Z",
    "applied_at": null
  }
}
```

- `code` luôn có giá trị (server tự cấp mã nếu account cũ chưa có).
- `share_url`: **có thể không có** (field bị bỏ hẳn chứ không phải `null`) khi server chưa cấu hình base URL. Khi đó app tự dựng nội dung chia sẻ từ `code`.
- `pending_referrals` = `total_referrals − qualified_referrals`.
- `total_earned_coin` (string) = tổng `REFERRAL_CREDIT` trừ `REFERRAL_CLAWBACK`, gồm cả phần đang pending.
- `terms.reward_pct` là **tỉ lệ thập phân** (`0.1` = 10%), không phải phần trăm nguyên. Các field trong `terms` là number hoặc boolean.
- `recent_activity`: tối đa 5 `REFERRAL_CREDIT` gần nhất. `coin` là number.
- `application` mô tả trạng thái **user này nhập mã của người khác**:
  - `status`: `eligible` (còn trong 72h, chưa nhập), `applied` (đã nhập), `expired` (quá 72h).
  - `can_redeem`: tính năng bật **và** `status = eligible`. Đây chỉ là kiểm tra sơ bộ, mã vẫn có thể bị từ chối khi submit.
  - `expires_at`: hạn nhập mã, bằng `null` khi đã `applied`. `applied_at`: thời điểm nhập mã hoặc `null`.

Lỗi:

- `401` lỗi auth.
- `404 USER_NOT_FOUND`.
- Account bị ban hoặc suspend **vẫn** xem được trang này.

### `POST /referral/redeem`

Nhập mã giới thiệu của người khác. **Auth:** Bearer. **Headers:** App headers. **Rate limit:** 10 request/60s/user.

Body:

| Field  | Kiểu   | Bắt buộc | Ràng buộc                                                                                 |
| ------ | ------ | -------- | ----------------------------------------------------------------------------------------- |
| `code` | string | có       | 1–32 ký tự. Server tự `trim()` và chuyển `toUpperCase()`, nên `" hp-7kq2mx "` vẫn hợp lệ. |

```json
{ "code": "HP-7KQ2MX" }
```

Response `200`:

```json
{ "ok": true }
```

Lỗi:

- `400 VALIDATION_ERROR`: `code` rỗng (`""`) hoặc dài hơn 32 ký tự. Chuỗi chỉ có khoảng trắng nhận `404 REFERRAL_CODE_NOT_FOUND`.
- `400 REFERRAL_SELF_BLOCKED`: nhập mã của chính mình.
- `401` lỗi auth.
- `404 REFERRAL_CODE_NOT_FOUND`: mã không tồn tại.
- `404 FEATURE_DISABLED`: region của referee hoặc referrer tắt referral.
- `404 USER_NOT_FOUND`.
- `409 REFERRAL_ALREADY_SET`: đã nhập mã trước đó (chỉ được nhập 1 lần).
- `409 REFERRAL_WINDOW_EXPIRED`: account đã tạo quá 72 giờ.
- `409 REFERRAL_BLOCKED`: bị chặn bởi luật chống gian lận (referrer bị khoá referral, hoặc hai account dùng chung GAID). Message cố ý chung chung.
- `429 RATE_LIMITED`.

## 13. Đổi quà (Catalog & Redemption)

Luồng: xem catalog → `POST /redemptions` (trừ coin ngay) → đơn đi qua các trạng thái fulfillment → khi `DELIVERED` và hết thời gian hold thì gọi `GET /redemptions/:id/code` để lấy mã.

`status` (tiến trình xử lý đơn): `REQUESTED` → `FRAUD_REVIEW` hoặc `APPROVED` → `PURCHASING` → `DELIVERED`. Nhánh kết thúc thất bại: `REJECTED`, `FAILED`. Khi `REJECTED`/`FAILED`, coin được hoàn lại (`REDEMPTION_REFUND`).

`claim_state` (trạng thái hiển thị trên màn phần thưởng):

- `PENDING`: chưa giao, hoặc đã giao nhưng chưa hết hold.
- `CLAIMABLE`: đã `DELIVERED` và `claimable_at` đã qua.
- `CLAIMED`: user đã mở mã ít nhất 1 lần.
- `REJECTED` / `FAILED`: ưu tiên hơn `CLAIMED`.

Thời gian hold (`claimable_at`) tính **từ lúc tạo đơn**, mặc định 48 giờ (cấu hình theo region, tối đa 720 giờ).

### `GET /catalog` (alias: `GET /redemptions/catalog`)

Hai path dùng chung handler. Trả danh sách quà đang active cho region của request. **Auth:** Không (public). **Headers:** App headers (bắt buộc). Region và quốc gia xác định theo **IP** (GeoIP).

Response `200`:

```json
{
  "categories": [
    { "id": "gift_card", "name": "Gift Cards" },
    { "id": "telco", "name": "Mobile Top-up" }
  ],
  "items": [
    {
      "id": "01929e00-aaaa-7bbb-8ccc-000000000001",
      "sku": "seagm-googleplay-us-10",
      "title": "Google Play Gift Card",
      "category_id": "gift_card",
      "subtitle": "US$10",
      "coin_price": "110000",
      "image_url": "https://cdn.example.com/catalog/gplay.png",
      "available": true,
      "stock_note": null,
      "recipient_type": "none"
    }
  ]
}
```

- `categories` chỉ gồm các nhóm thực sự có item trong kết quả. `name` là nhãn tiếng Anh (`gift_card` → Gift Cards, `game_card` → Game Cards, `paypal` → PayPal, `telco` → Mobile Top-up; slug khác được Title Case).
- `coin_price` là **string**.
- `available` hiện luôn `true`.
- `image_url`, `stock_note` có thể `null`.
- `recipient_type`: `none` (quà là mã, giao qua `GET /redemptions/:id/code`) | `paypal_email` (tiền được gửi vào tài khoản PayPal — app phải hỏi email PayPal trước khi đổi và gửi kèm `recipient_email` ở `POST /redemptions`).
- Item được lọc theo IP lúc xem, nhưng khi tạo đơn server kiểm tra lại theo `country_code`/`region_id` lưu trên account. Vì vậy một item thấy được trong catalog vẫn có thể bị từ chối nếu user dùng VPN.

Lỗi:

- `400 VALIDATION_ERROR`: thiếu app headers.

### `POST /redemptions`

Tạo đơn đổi quà. Coin bị trừ ngay khỏi `available` (`REDEMPTION_DEBIT`). **Auth:** Bearer. **Headers:** App headers. **Không có Idempotency-Key**: mỗi request thành công tạo một đơn mới, nên app cần chống double-tap.

Body:

| Field             | Kiểu   | Bắt buộc | Ràng buộc                                                                                                                                                                    |
| ----------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog_item_id` | string | có       | `id` (UUID) của item trong catalog                                                                                                                                           |
| `recipient_email` | string | tuỳ item | Email PayPal nhận tiền, ≤ 254 ký tự, dạng `a@b.c`, không có khoảng trắng (app tự trim). **Bắt buộc** khi item có `recipient_type = "paypal_email"`; bị bỏ qua với item khác. |

```json
{ "catalog_item_id": "01929e00-aaaa-7bbb-8ccc-000000000001" }
```

Response `200` (`RedemptionResponse`):

```json
{
  "id": "01929fb0-0000-7aaa-8bbb-000000000010",
  "status": "APPROVED",
  "catalog_item_id": "01929e00-aaaa-7bbb-8ccc-000000000001",
  "reward": {
    "sku": "seagm-googleplay-us-10",
    "title": "Google Play Gift Card",
    "category": "gift_card",
    "face_value": "US$10",
    "image_url": "https://cdn.example.com/catalog/gplay.png"
  },
  "coin_price": "110000",
  "usd_cost_est": "10.5000",
  "fraud_score_at_request": 12,
  "reject_reason": null,
  "delivery_note": null,
  "delivered_at": null,
  "claimed_at": null,
  "recipient_email_masked": null,
  "claim_state": "PENDING",
  "claimable_at": "2026-10-16T03:30:00.000Z",
  "seconds_until_claimable": 172800,
  "can_claim_now": false,
  "created_at": "2026-10-14T03:30:00.000Z",
  "updated_at": "2026-10-14T03:30:00.000Z"
}
```

- `status` trả về ngay có thể là `APPROVED` (tự duyệt), `FRAUD_REVIEW` (cần người duyệt: fraud score ≥ 30, đơn đầu tiên khi account dưới 24 giờ tuổi, hoặc region tạm dừng auto-approve), hoặc `REJECTED` (fraud score ≥ 90: đơn bị từ chối, coin được hoàn ngay, **và account bị chuyển sang suspended**).
- `reward` là snapshot của item tại thời điểm đổi. Field ở đây dùng tên DB (`category`, `face_value`), khác với tên trong catalog (`category_id`, `subtitle`).
- `coin_price`, `usd_cost_est` là string (`usd_cost_est` có 4 chữ số thập phân, vd `"10.5000"`). `fraud_score_at_request` là number hoặc `null`.
- `seconds_until_claimable` (integer ≥ 0) dùng để chạy countdown. `can_claim_now` tương đương `claim_state == "CLAIMABLE"`.
- `recipient_email_masked`: email PayPal đã nhập, dạng che (`a***@gmail.com`), để hiện "Gửi tới a***@gmail.com"; `null` với quà dạng mã. Server không bao giờ trả lại email đầy đủ. Với quà PayPal, "mã" ở `GET /redemptions/:id/code` là mã giao dịch PayPal.

Lỗi:

- `400 VALIDATION_ERROR`: thiếu `catalog_item_id`, hoặc `recipient_email` sai định dạng.
- `400 RECIPIENT_REQUIRED`: item cần email PayPal nhưng không gửi `recipient_email`. Không trừ coin.
- `400 CATALOG_ITEM_UNAVAILABLE`: item không tồn tại, đã tắt, hoặc không bán cho quốc gia hay region của account.
- `400 REDEMPTION_WEEKLY_CAP`: vượt trần USD đổi quà trong 7 ngày cuộn (trần theo trust level).
- `400 INSUFFICIENT_BALANCE`: không đủ coin available.
- `401` lỗi auth.
- `403 REDEMPTION_BLOCKED`: account bị ban hoặc không active.
- `403 REDEMPTION_SUSPENDED`: account bị suspend.
- `404 FEATURE_DISABLED`: region tắt đổi quà.
- `404 USER_NOT_FOUND` / `404 WALLET_NOT_FOUND`.
- `500 REDEMPTION_CONFIG_MISSING`: region chưa cấu hình trần (lỗi server).
- `catalog_item_id` không phải UUID có thể gây `500 INTERNAL_ERROR` vì schema chỉ kiểm tra `minLength: 1`.

### `GET /redemptions`

Danh sách đơn đổi quà của user, mới nhất trước. **Auth:** Bearer. **Headers:** App headers.

Query:

| Tên      | Kiểu                                                                                          | Bắt buộc | Ràng buộc                              |
| -------- | --------------------------------------------------------------------------------------------- | -------- | -------------------------------------- |
| `status` | enum `REQUESTED`\|`FRAUD_REVIEW`\|`APPROVED`\|`PURCHASING`\|`DELIVERED`\|`REJECTED`\|`FAILED` | không    | Lọc theo trạng thái                    |
| `cursor` | string                                                                                        | không    | `next_cursor` của trang trước (id đơn) |
| `limit`  | integer                                                                                       | không    | 1–100, mặc định **50**                 |

Response `200`:

```json
{
  "items": [
    {
      "id": "01929fb0-0000-7aaa-8bbb-000000000010",
      "status": "DELIVERED",
      "claim_state": "CLAIMABLE",
      "...": "các field giống RedemptionResponse ở trên"
    }
  ],
  "next_cursor": null
}
```

- Mỗi item có đúng các field của `RedemptionResponse` như trong ví dụ `POST /redemptions`.

Lỗi:

- `400 VALIDATION_ERROR`: `status` hoặc `limit` không hợp lệ.
- `401` lỗi auth.
- `cursor` không phải UUID có thể gây `500 INTERNAL_ERROR`. Chỉ truyền đúng `next_cursor` server trả về.

### `GET /redemptions/:id`

Chi tiết một đơn kèm timeline. Dùng endpoint này để poll trong lúc countdown. **Auth:** Bearer. **Headers:** App headers.

Params: `id` (string, bắt buộc, là UUID của đơn).

Response `200`: toàn bộ field của `RedemptionResponse`, thêm `timeline`:

```json
{
  "id": "01929fb0-0000-7aaa-8bbb-000000000010",
  "status": "DELIVERED",
  "catalog_item_id": "01929e00-aaaa-7bbb-8ccc-000000000001",
  "reward": {
    "sku": "seagm-googleplay-us-10",
    "title": "Google Play Gift Card",
    "category": "gift_card",
    "face_value": "US$10",
    "image_url": null
  },
  "coin_price": "110000",
  "usd_cost_est": "10.5000",
  "fraud_score_at_request": 12,
  "reject_reason": null,
  "delivery_note": "Redeem at play.google.com/redeem",
  "delivered_at": "2026-10-15T02:00:00.000Z",
  "claimed_at": null,
  "recipient_email_masked": null,
  "claim_state": "CLAIMABLE",
  "claimable_at": "2026-10-16T03:30:00.000Z",
  "seconds_until_claimable": 0,
  "can_claim_now": true,
  "created_at": "2026-10-14T03:30:00.000Z",
  "updated_at": "2026-10-15T02:00:00.000Z",
  "timeline": [
    { "status": "REQUESTED", "actor": "user", "note": null, "at": "2026-10-14T03:30:00.000Z" },
    {
      "status": "APPROVED",
      "actor": "system",
      "note": "Auto-approved",
      "at": "2026-10-14T03:30:00.000Z"
    },
    { "status": "PURCHASING", "actor": "admin", "note": null, "at": "2026-10-15T01:00:00.000Z" },
    { "status": "DELIVERED", "actor": "admin", "note": null, "at": "2026-10-15T02:00:00.000Z" }
  ]
}
```

- `timeline` xếp theo thời gian tăng dần. `actor` là chuỗi tự do (`user`, `system`, hoặc tác nhân phía admin).

Lỗi:

- `401` lỗi auth.
- `404 REDEMPTION_NOT_FOUND`: không tồn tại hoặc không thuộc user. Hai trường hợp được trả giống nhau.
- `id` không phải UUID có thể gây `500 INTERNAL_ERROR`.

### `GET /redemptions/:id/code`

Lấy mã quà (giải mã phía server). Lần gọi thành công đầu tiên sẽ đặt `claimed_at`, làm `claim_state` chuyển sang `CLAIMED`. Gọi lại vẫn trả mã. **Auth:** Bearer. **Headers:** App headers. **Rate limit:** 5 request/giờ cho mỗi cặp (user, đơn).

Params: `id` (string, bắt buộc).

Response `200`:

```json
{
  "redemption_id": "01929fb0-0000-7aaa-8bbb-000000000010",
  "delivery_code": "ABCD-EFGH-IJKL-MNOP",
  "delivery_note": "Redeem at play.google.com/redeem"
}
```

Lỗi:

- `400 DELIVERY_CODE_UNAVAILABLE`: đơn chưa `DELIVERED` hoặc chưa có mã.
- `401` lỗi auth.
- `404 REDEMPTION_NOT_FOUND`.
- `409 REDEMPTION_HOLD_ACTIVE`: chưa hết hold. Body có thêm `claimable_at` để chạy countdown:
  ```json
  {
    "error": {
      "code": "REDEMPTION_HOLD_ACTIVE",
      "message": "Reward is not claimable yet",
      "claimable_at": "2026-10-16T03:30:00.000Z"
    }
  }
  ```
- `429 RATE_LIMITED`: quá 5 lần/giờ cho đơn này. Rate limit được kiểm tra **trước** mọi điều kiện khác, nên các lần gọi bị 404/409 cũng bị tính vào quota.

## 14. Phản hồi & báo cáo

### `POST /feedback`

Gửi đánh giá app từ màn "Rate the app". **Auth:** Bearer. **Headers:** không bắt buộc; nếu có `X-App-Version` thì được lưu kèm (cắt còn 32 ký tự). **Rate limit:** 5 lần/giờ/user.

Body:

| Field     | Kiểu    | Bắt buộc | Ràng buộc                                                               |
| --------- | ------- | -------- | ----------------------------------------------------------------------- |
| `rating`  | integer | có       | 1–5 sao                                                                 |
| `message` | string  | không    | ≤ 2000 ký tự. Chỉ có khoảng trắng thì coi như không có.                 |
| `email`   | string  | không    | Email để đội ngũ trả lời, ≤ 254 ký tự, dạng `a@b.c`, không khoảng trắng |

```json
{ "rating": 4, "message": "Love the reader, wish it had dark mode", "email": "reader@example.com" }
```

Response `200`:

```json
{ "id": "0192fa00-0000-7000-8000-000000000001", "created_at": "2026-10-14T08:30:00.000Z" }
```

- Server chỉ lưu để đội ngũ đọc trong CMS; không có phản hồi tự động. Với 4–5 sao app có thể mở luôn trang đánh giá trên store.

Lỗi:

- `400 VALIDATION_ERROR` — `rating` ngoài 1–5, `message` quá dài, `email` sai định dạng.
- `401` lỗi auth.
- `429 RATE_LIMITED` — quá 5 lần/giờ.

### `POST /reports`

Báo cáo nội dung (truyện, chương) hoặc sự cố app từ màn "Report a problem". **Auth:** Bearer. **Headers:** không bắt buộc. **Rate limit:** 10 lần/giờ/user.

Body:

| Field         | Kiểu   | Bắt buộc | Ràng buộc                                                                                                                                                                                      |
| ------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_type` | string | có       | `novel` \| `chapter` \| `app`                                                                                                                                                                  |
| `target_id`   | string | tuỳ loại | UUID. **Bắt buộc** với `novel` (id truyện) và `chapter` (`id` UUID của chương trong mục lục); bị bỏ qua với `app` (nhưng nếu gửi vẫn phải là UUID hợp lệ, nên với `app` hãy bỏ hẳn field này). |
| `reason`      | string | có       | `inappropriate` \| `copyright` \| `wrong_content` \| `spam` \| `other`                                                                                                                         |
| `message`     | string | không    | ≤ 2000 ký tự. Chỉ có khoảng trắng thì coi như không có.                                                                                                                                        |

```json
{
  "target_type": "chapter",
  "target_id": "0192f7b1-aaaa-7bbb-8ccc-000000000065",
  "reason": "wrong_content",
  "message": "Đoạn 3 bị lặp"
}
```

Response `200`:

```json
{
  "id": "0192fa10-0000-7000-8000-000000000001",
  "status": "open",
  "created_at": "2026-10-14T08:30:00.000Z"
}
```

- Báo cáo được đội ngũ xử lý trong CMS; app không cần theo dõi trạng thái.

Lỗi:

- `400 VALIDATION_ERROR` — thiếu `target_id` với `novel`/`chapter`, `target_type`/`reason` không hợp lệ, `message` quá dài.
- `401` lỗi auth.
- `404 REPORT_TARGET_NOT_FOUND` — không có truyện/chương với `target_id` này.
- `429 RATE_LIMITED` — quá 10 lần/giờ.

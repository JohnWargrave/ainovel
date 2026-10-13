# Luồng người dùng: nhận coin, làm nhiệm vụ, đọc truyện

> Trích từ [NOVEL_MIGRATION_PLAN.md](NOVEL_MIGRATION_PLAN.md) §6–§7. Phần đánh dấu (MỚI) là tính năng sẽ làm theo plan.


## Tổng quan vòng đời coin

```
            ┌──────────── NGUỒN COIN (mint) ────────────┐
 Đăng ký ──►│ Welcome bonus · Liên kết Google            │
 Mỗi ngày ─►│ Điểm danh (streak 7 ngày) · Nhiệm vụ ngày  │
 Đọc ──────►│ Đọc xong chương free  (MỚI)                │──► Ví: pending ──(hết hold)──► available
 Quảng cáo ►│ Rewarded ad (earncoin/checkin)             │                                   │
 Offerwall ►│ Tapjoy / PubScale / adjoe / AppsPrize/AdGate│                                  │
 Bạn bè ───►│ Referral (% thu nhập offerwall của bạn)    │                                   │
 Spin ─────►│ Lucky Spin (mỗi lượt = 1 ad)               │                                   │
            └────────────────────────────────────────────┘                                   ▼
            ┌──────────── TIÊU COIN (debit) ────────────┐                      ┌───────────────────┐
            │ Mở khoá chương VIP (MỚI)                   │◄──── available ─────►│ Đổi quà (redeem)  │
            └────────────────────────────────────────────┘                      │ thẻ cào/gift card │
                                                                                └───────────────────┘
```

- Mọi biến động coin đi qua **sổ cái** `coin_ledger` + ví `wallets` (khoá `FOR UPDATE`, idempotency key → không cộng trùng).
- Coin **pending**: coin offerwall/referral bị giữ N ngày (chống network thu hồi); job `hold-release` chuyển sang **available** mỗi 5 phút.
- Coin **"không có doanh thu đứng sau"** (welcome, điểm danh, nhiệm vụ, đọc truyện, spin) bị giới hạn chung **20.000 coin / 30 ngày / user** + công tắc khẩn cấp tắt mint toàn hệ thống.
- Mọi số coin, trần, tỉ lệ đều cấu hình **theo region** trong CMS (không cần deploy).

## Luồng chi tiết

**A. Vào app lần đầu**
1. App gửi `X-Device-Id` → `POST /auth/guest` → tạo tài khoản guest + nhận **welcome bonus** (1 lần/thiết bị).
2. Liên kết Google/Facebook/email → nhận **bonus liên kết** (1 lần), giữ được tài khoản khi đổi máy.
3. `GET /config` → app biết region bật tính năng nào (novel, spin, offerwall…), mức thưởng, trần.

**B. Đọc truyện nhận coin (MỚI)**
1. Trang chủ `GET /novels/home` → chọn truyện → `GET /novels/:id/chapters` (mục lục: chương nào free/VIP/đã thưởng).
2. Mở chương `GET /novels/:id/chapters/:no`. Nếu chương VIP chưa mở → nhận `CHAPTER_LOCKED` + giá.
3. Trong lúc đọc, app gửi `POST /novels/read-heartbeat {chapter_id, scroll_ratio}` mỗi ~10 giây.
4. Server cộng **thời gian đọc thật** (đồng hồ server, tối đa 30s/beat), chỉ cho **1 chương đang đọc** tại một thời điểm.
5. Khi đủ **thời gian tối thiểu** (tính từ số chữ của chương, vd 3.000 chữ / 300 wpm × 50% = 5 phút, kẹp 30s–15 phút) **và** cuộn ≥ 90% → cộng `chapter_reward_coin` (vd 10 coin) vào **available**. Response có `rewarded: true` để app chạy hiệu ứng.
6. Mỗi chương chỉ thưởng **1 lần**; tối đa **N chương/ngày** (vd 20); **chương VIP không có thưởng đọc**.

**C. Mở khoá chương VIP (MỚI)**
- **Bằng coin**: `POST /novels/chapters/:id/unlock {method:'coin'}` → trừ coin (`CHAPTER_UNLOCK_DEBIT`), mở vĩnh viễn cho user.
- **Bằng quảng cáo**: `POST /earning/rewarded-ad/intent {placement:'chapter_unlock'}` → xem ad → Google gọi SSV về server → app gọi `unlock {method:'ad', intent_id}` → mở chương. 1 ad = 1 chương, có trần ad/ngày.
- Thường cấu hình: N chương đầu free, sau đó VIP.

**D. Điểm danh hằng ngày** — `GET /checkin/state` → `POST /checkin/claim`: streak 7 ngày (mặc định 10/15/20/25/30/40/100 coin), lặp lại; bỏ 1 ngày → về ngày 1. Reset theo múi giờ region.

**E. Nhiệm vụ** — `GET /earning/tasks` → `POST /earning/tasks/claim`: nhiệm vụ ngày cấu hình theo region (`daily_login`, `share_app`, `invite_friend`). Nhiệm vụ "xem ad" không claim tay (đã trả qua SSV). *(Đề xuất thêm nhiệm vụ đọc: "đọc 3 chương hôm nay" — server tự kiểm từ `novel_read_progress`, không cho claim tay.)*

**F. Xem quảng cáo nhận coin** — `POST /earning/rewarded-ad/intent {placement:'earncoin'}` → xem AdMob → Google gọi `/postback/admob_ssv` (có chữ ký ECDSA) → cộng coin theo eCPM ước tính × hệ số. Có trần/ngày + cooldown theo placement.

**G. Offerwall (Tapjoy, PubScale, adjoe, AppsPrize, AdGate)** — `GET /offerwall/offers` → user cài app/game, đạt mốc → network gọi **postback** về server (kiểm chữ ký + IP) → coin = payout USD × 10.000 × tỉ lệ chia theo trust level → vào **pending** và tự release sau thời gian hold. Network thu hồi (reversal) → trừ lại coin.

**H. Lucky Spin** — `GET /spin/state`; mỗi lượt quay phải xem 1 ad (`placement:'luckyspin'`), + 1 lượt free/ngày. Giải thưởng coin theo bảng tỉ lệ cấu hình, có cơ chế "pity".

**I. Giới thiệu bạn bè** — mỗi user có mã `HP-XXXXXX`; bạn nhập mã (`POST /referral/redeem`) → người giới thiệu nhận % thu nhập offerwall của bạn (có hold, bị thu hồi nếu offer bị thu hồi). Fraud rule chặn cùng thiết bị/cùng dải IP.

**J. Đổi quà** — `GET /catalog` → `POST /redemptions` (trừ coin ngay) → fraud check (điểm cao → admin review / từ chối + hoàn coin) → admin duyệt, mua, nhập mã → user xem mã tại `GET /redemptions/:id/code` sau thời gian chờ. Trần giá trị đổi/tuần theo trust level.

**K. Ví** — `GET /wallet` (available/pending), `GET /wallet/ledger` (lịch sử có nhãn).

## Chống hack / gian lận / DDoS

**Trả lời ngắn:** plan ở trên mới chỉ chống gian lận cho phần đọc truyện; phần còn lại đang **follow y hệt app cũ**, mà app cũ có nhiều lỗ (đã thấy trong phân tích trước). Đề xuất bổ sung các mục dưới đây vào plan — chia 2 mức.

### 7.1 App cũ đã có (giữ nguyên)
- Chữ ký postback constant-time, IP allowlist network, SSV AdMob ECDSA, idempotency ledger, khoá ví `FOR UPDATE`.
- Fraud engine (điểm, tự khoá ở tier đỏ, review đổi quà), hold coin offerwall, trần unbacked 20k/30 ngày, mint kill-switch.
- Rate limit theo IP/subject cho auth, heartbeat, referral, direct-coin; admin: argon2, khoá sau 5 lần sai, cookie HttpOnly+SameSite Strict, CSRF.
- `trustProxy` chỉ tin danh sách cấu hình.

### 7.2 Bắt buộc sửa cùng đợt này (lỗ hổng gây mất tiền)
1. **Hold-release sau thu hồi** — đặt `hold_until = NULL` khi reversal (`src/modules/postback/postback.service.ts:127`), try/catch từng dòng trong `src/jobs/hold-release.ts:29`.
2. **Spin nhận intent placement NULL** → chỉ chấp nhận `luckyspin` (`src/modules/spin/spin.service.ts:360`); novel unlock cũng bắt buộc đúng placement.
3. **SSV không kiểm `ad_unit`** → thêm allowlist `ad_unit` theo placement trong `rewarded_ads` settings, từ chối callback lạ (`src/modules/rewarded-ads/ssv.service.ts`).
4. **Farm tài khoản guest** — welcome bonus chỉ cộng khi **liên kết Google** hoặc chuyển vào **pending** tới khi có tín hiệu tin cậy; thêm rate limit tạo guest theo /24 IP + GAID; (khuyến nghị) **Play Integrity API** cho đăng ký và các lệnh nhận coin.
5. **`POST /earning/coin` (direct coin)** — client tự khai số coin; nếu app novel không dùng → **tắt và gỡ route**; nếu cần → chỉ cho server/admin gọi.
6. **Race trần đổi quà tuần** — khoá user/ví trước khi tính trần (`src/modules/redemption/redemption.service.ts:430`).
7. **User bị khoá vẫn nhận coin** — chặn credit/release cho `suspended/banned` ở postback + hold-release.
8. **Admin bị khoá vĩnh viễn** — reset `failed_login_count` khi hết hạn khoá (`src/modules/admin/session-routes.ts:96`); thêm rate limit `/auth/password/change`.
9. **Secret yếu** — env yêu cầu JWT/CMS secret ≥ 32 ký tự, access ≠ refresh secret (`src/config/env.ts:13`).

### 7.3 Chống gian lận riêng cho novel (đã nằm trong plan §2)
- Nội dung, số chữ, trạng thái chương do **server sở hữu**; client chỉ gửi `chapter_id` + `scroll_ratio`.
- Thời gian đọc theo **đồng hồ server**, 1 phiên đọc/user, khoá user khi tính trần ngày, idempotency mỗi chương, trần unbacked chung.
- **Chống cào nội dung**: rate limit `GET chapter` theo user (vd 60 chương/giờ) + theo IP; không có API tải cả truyện; log & cảnh báo user đọc bất thường (fraud rule mới **N01**: > X chương/giờ, thời gian đọc đều bất thường → cộng điểm fraud).
- Mở khoá bằng coin trong transaction với khoá ví → không âm coin, không mở trùng.

### 7.4 Chống DDoS / lạm dụng hạ tầng
- **Lớp biên (khuyến nghị mạnh)**: đặt **Cloudflare** (hoặc tương đương) trước API — WAF, chặn bot, rate limiting theo IP, ẩn IP origin; firewall server chỉ nhận traffic từ Cloudflare. Khi đó cấu hình **`TRUST_PROXY`** đúng dải IP Cloudflare/nginx (hiện để trống → mọi user chung 1 IP).
- **nginx** (`deploy/nginx`): `limit_req`/`limit_conn` theo IP, timeout header/body, chặn body lớn ngoài route import.
- **Ứng dụng**:
  - Rate limit **toàn cục** theo IP + theo user cho mọi route có token (hiện chỉ có ở vài route); dùng Lua script atomic thay `INCR`+`EXPIRE` (`src/lib/rate-limit.ts:23`).
  - `bodyLimit` mặc định nhỏ (vd 64KB), chỉ route import được 50MB; giới hạn số file/kích thước multipart; import chạy ở **worker**, không chặn API.
  - Cache Redis cho dữ liệu đọc nhiều: `/config`, `/novels/home`, mục lục, nội dung chương (vô hiệu hoá khi CMS sửa) → giảm tải Postgres khi bị dội.
  - Thêm `@fastify/helmet` (header bảo mật cho `/cms`), CORS rõ ràng.
  - Postgres: `statement_timeout`, pool giới hạn; Redis đặt mật khẩu, không public port.
- **Giám sát**: alert khi mint/giờ vượt ngưỡng (đã có `economy-backing-alert`), tỉ lệ 4xx/5xx, số guest mới/giờ, số heartbeat/giờ; kill-switch mint để tắt nhanh khi bị tấn công.

### 7.5 Thứ tự gợi ý
Làm **§7.2 mục 1–5** trước khi mở app novel cho người dùng thật; §7.4 lớp biên (Cloudflare + `TRUST_PROXY`) cùng lúc deploy; phần còn lại làm song song với CMS.


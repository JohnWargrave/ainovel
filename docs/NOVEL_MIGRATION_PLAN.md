# Plan: Chuyển app "xem drama nhận thưởng" → "đọc novel nhận thưởng" + CMS quản lý tiểu thuyết

## Context

Backend AINovel hiện có module `drama` (xem phim → heartbeat → nhận coin). Sản phẩm chuyển hướng sang **đọc tiểu thuyết nhận thưởng**. Toàn bộ kinh tế coin còn lại (offerwall Tapjoy/PubScale/…, rewarded ads, spin, check-in, referral, redemption, fraud, ledger) **giữ nguyên**. Cần:
1. Module `novel` cho app: duyệt truyện, đọc chương, thưởng coin khi đọc xong chương, khoá chương VIP mở bằng coin hoặc xem ads.
2. CMS quản lý tiểu thuyết: CRUD, chương, import (EPUB/TXT/MD/DOCX/JSON/ZIP), export, thống kê.
3. Xoá hẳn drama.

Quyết định đã chốt với user:
- Thưởng: **đọc xong chương** (đủ thời gian đọc tối thiểu theo số chữ + cuộn tới cuối), có trần/ngày.
- Khoá chương VIP: mở bằng **coin hoặc rewarded ad**. **Chỉ chương free được thưởng đọc** (tránh vòng tiêu–nhận coin).
- Lưu trữ: **text chương trong Postgres, ảnh bìa trên S3/R2** (S3-compatible + CDN).
- Import: EPUB, TXT/Markdown, JSON/ZIP, DOCX.
- Drama: **xoá hẳn** (giữ lịch sử ledger `DRAMA_WATCH_CREDIT`).

Đồng thời sửa luôn các lỗ hổng đã thấy ở drama khi viết lại: nội dung do client tự khai (`drama_id`/`duration` không có thật), race trần ngày, nhiều phiên song song.

---

## 1. Database (migrations 065–067)

**065_novel_ledger_types.cjs** — `ALTER TYPE ledger_entry_type ADD VALUE` (ngoài transaction, theo mẫu 011/023/040/062): `NOVEL_READ_CREDIT`, `CHAPTER_UNLOCK_DEBIT`.

**066_novels.cjs** — bảng mới (id UUID do app sinh `uuidv7()`, TIMESTAMPTZ, raw SQL như migration 064):

| Bảng | Cột chính |
|---|---|
| `novel_categories` | id, slug UNIQUE, name, sort_order, is_active |
| `novels` | id, slug UNIQUE, title, alt_titles TEXT[], author, translator, description, cover_url, cover_key, status (`draft/published/hidden/archived`), completion_status (`ongoing/completed/hiatus`), language, tags TEXT[], region_codes CHAR(2)[] (NULL = mọi region), is_featured, featured_rank, **free_chapter_count**, **default_unlock_coin**, **allow_ad_unlock**, chapter_count, word_count, search_vector tsvector (GIN), published_at, created_by, created_at, updated_at |
| `novel_category_links` | novel_id, category_id (PK kép) |
| `novel_chapters` | id, novel_id FK, chapter_no, title, content TEXT, word_count, **is_vip**, unlock_coin_price (NULL = dùng default của novel), status (`draft/published`), publish_at (lên lịch), created_at, updated_at; UNIQUE(novel_id, chapter_no) |
| `novel_chapter_revisions` | id, chapter_id, title, content, edited_by, created_at (lịch sử sửa) |
| `novel_chapter_unlocks` | id, user_id, chapter_id, method (`coin/ad`), coin_spent, ad_intent_id, created_at; UNIQUE(user_id, chapter_id) |
| `novel_read_progress` | id, user_id, chapter_id FK, novel_id, read_time_s, max_scroll_ratio, last_heartbeat_at, rewarded_at, created_at; UNIQUE(user_id, chapter_id); index (user_id, rewarded_at DESC) |
| `novel_library` | user_id, novel_id, last_chapter_id, last_read_at, in_bookshelf BOOL (PK kép) — tủ truyện + "đọc tiếp" |
| `novel_import_jobs` | id, admin_user_id, format, filename, file_key, mode (`new/append/replace`), target_novel_id, status (`queued/parsing/ready/committing/done/failed`), preview JSONB, stats JSONB, errors JSONB, created_at, finished_at |
| `novel_import_chapters` | id, job_id FK, chapter_no, title, content, word_count, warnings TEXT[] (staging, theo mẫu catalog staging) |

- `rewarded_ad_intents` thêm `chapter_unlock_id UUID` + partial UNIQUE index (giống `spin_history_id` ở migration 061) để 1 ad chỉ mở 1 chương.
- `region_config.features.novel` seed: `{enabled:false, chapter_reward_coin:10, reading_wpm:300, min_read_ratio:0.5, min_read_seconds:30, max_read_seconds:900, completion_scroll_ratio:0.9, chapter_reward_daily_cap:20}`.
- `features.rewarded_ads.placements.chapter_unlock` seed: `{daily_cap:10, cooldown_s:0, coin_multiplier:0}` (ad dùng để mở chương, không mint coin).

**067_drop_drama.cjs** — DROP `drama_watch_progress`, `drama_episodes`, `drama_series`, `drama_ad_impressions`, `watch_sessions`; xoá key `features.drama`. Không đụng enum (Postgres không drop được giá trị enum; lịch sử ledger giữ nguyên).

Cập nhật `src/db/types.ts`: thêm các `XTable` + đăng ký trong `DB`, thêm 2 entry type vào `LedgerEntryType`, xoá các bảng drama.

## 2. Backend module `src/modules/novel/`

Cấu trúc theo mẫu catalog/drama: `routes.ts`, `schemas.ts`, `novel.service.ts` (duyệt/đọc), `reading.service.ts` (heartbeat + thưởng), `unlock.service.ts`, `region-feature.ts` (`parseNovelFeature`, thay `parseDramaFeature`), `admin-routes.ts`, `admin.service.ts`, `admin-schemas.ts`, `import/` (parsers + job), `export/`, `storage.ts`.

### API cho app (auth guard như drama, đăng ký trong `registerJsonApiRoutes` → có cả root và `/v1`)
- `GET /novels` — lọc category/tag/completion, `q` (full-text `search_vector`), sort `new|updated|popular`, keyset cursor.
- `GET /novels/home` — featured, mới cập nhật, top đọc (theo region).
- `GET /novels/categories`
- `GET /novels/:id` — chi tiết + trạng thái thư viện của user.
- `GET /novels/:id/chapters` — mục lục phân trang, mỗi chương kèm `is_vip`, `locked`, `price`, `ad_unlock`, `rewarded`.
- `GET /novels/:id/chapters/:chapter_no` — trả nội dung nếu free hoặc đã unlock; nếu khoá trả `403 CHAPTER_LOCKED` + `publicDetails {price, ad_unlock}`. Rate limit theo user (chống cào nội dung) bằng `checkSubjectRateLimit`.
- `POST /novels/chapters/:id/unlock` — body `{method:'coin'}` hoặc `{method:'ad', intent_id}`.
- `POST /novels/read-heartbeat` — body `{chapter_id, scroll_ratio}`.
- `GET /library`, `PUT /library/:novel_id`, `DELETE /library/:novel_id` — tủ truyện; lịch sử đọc tự cập nhật qua heartbeat.
- `/config`: thay `features.drama` bằng `features.novel` (`src/modules/config/config.service.ts:118`, `config/schemas.ts:8`).

### Thưởng đọc (`reading.service.ts`, viết lại từ `heartbeat.service.ts`)
- Chương **phải tồn tại, published, đúng region, và là chương free** — server tự có `word_count`, không tin client.
- `required_s = clamp(word_count / reading_wpm × 60 × min_read_ratio, min_read_seconds, max_read_seconds)`.
- Mỗi heartbeat (~10s): `gain = clamp(serverDelta, 0, 30)`; beat đầu chỉ tạo baseline (giữ nguyên ý tưởng `verifiedGain` của drama).
- **Một phiên đọc đang hoạt động/user**: lưu `active_chapter` trong Redis (`redis.lock`, TTL 60s); heartbeat cho chương khác trong lúc phiên cũ còn sống → không cộng thời gian.
- **Khoá theo user** khi kiểm tra trần ngày: `SELECT … FROM users WHERE id = ? FOR UPDATE` trong transaction trước `countRewardedToday` → hết race giữa các chương.
- Đủ `read_time_s ≥ required_s` và `max_scroll_ratio ≥ completion_scroll_ratio` → `creditInTransaction` (`src/modules/wallet-ledger/ledger.service.ts:121`) với `NOVEL_READ_CREDIT`, idempotency `novel-read:{user}:{chapter}`; sau commit `recordMint` như drama.
- Thêm `NOVEL_READ_CREDIT` vào `UNBACKED_ENTRY_TYPES` (`ledger.service.ts:13`) → tự áp trần 20k/30 ngày + mint kill-switch + tách số liệu analytics.
- Account bị khoá: dùng `loadUserRegionFeatures` (`src/modules/earning/region-features.ts`) như hiện tại.

### Mở khoá chương (`unlock.service.ts`)
- **Coin**: một transaction: kiểm tra chương VIP + chưa unlock → `debitInTransaction` (`ledger.service.ts:240`) `CHAPTER_UNLOCK_DEBIT`, idempotency `chapter-unlock:{user}:{chapter}` → insert `novel_chapter_unlocks`. Giá = `unlock_coin_price ?? novels.default_unlock_coin`.
- **Ad**: tái dùng luồng rewarded ads + SSV có sẵn. Thêm placement `chapter_unlock` vào `REWARDED_AD_PLACEMENTS` (`src/modules/rewarded-ads/region-feature.ts:5`) và `schemas.ts:12`. Validate intent theo mẫu `assertSpinAdIntent` (`src/modules/spin/spin.service.ts:350`) nhưng **bắt buộc `placement === 'chapter_unlock'`** (không chấp nhận NULL — tránh lỗi double-reward như spin), lock intent, gán `chapter_unlock_id`.
- Chương VIP không được thưởng đọc (theo quyết định).

### Ảnh bìa — `storage.ts`
- Thêm dependency `@aws-sdk/client-s3` (S3/R2/MinIO đều được). Env mới trong `src/config/env.ts`: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` (optional, thiếu → 503 `CONFIGURATION_ERROR` khi upload, giống cách drama xử lý secret thiếu).
- Upload qua backend: validate MIME (jpeg/png/webp) + kích thước (≤ 5MB), key `covers/{novel_id}/{uuid}.{ext}`.
- Thêm `docker-compose.yml` service MinIO cho dev.

### Ảnh bìa AI — `cover-ai/` (migration 079)
- Nút **"Generate AI cover"** trong panel ảnh bìa của CMS tạo một job `novel_cover_jobs`, đưa vào BullMQ queue `novel-cover` và chạy ở worker:
  1. **Brief:** DeepSeek (`COVER_AI_BRIEF_MODEL`, mặc định `deepseek-flash`, API OpenAI-compatible, JSON mode) đọc tên truyện, tác giả, mô tả, thể loại, tags và khoảng 6.000 ký tự đầu của 2 chương đầu, rồi trả về brief JSON tiếng Anh. DeepSeek không có API sinh ảnh nên bước vẽ vẫn dùng Workers AI.
     - Quy tắc: ảnh không có chữ, phong cách theo thể loại, không nội dung nhạy cảm, chừa trống 1/3 dưới cho tiêu đề.
     - Nếu admin tự gõ prompt thì bỏ qua bước này.
     - Gọi kiểu streaming. Nếu sau 90s DeepSeek vẫn chưa trả token nào, hoặc tổng thời gian quá 180s, thì báo `COVER_AI_BRIEF_TIMEOUT`.
     - Khi DeepSeek lỗi hoặc timeout, job không fail: hệ thống dùng prompt dựng sẵn theo thể loại (`fallbackBrief`) và ghi lý do vào `errors` để CMS hiển thị.
  2. **Render:** Workers AI FLUX.2 (`COVER_AI_IMAGE_MODEL`, mặc định `@cf/black-forest-labs/flux-2-klein-4b`), gọi REST multipart, khổ 832×1248, **chỉ 1 ảnh mỗi job** để tiết kiệm credit.
     - Lần đầu lỗi thì thử lại 1 lần với seed khác; cả 2 lần lỗi thì job `failed` và bìa giữ nguyên.
  3. **Ghép chữ:** `sharp` thêm dải tối, tên truyện và tác giả bằng font Be Vietnam Pro đi kèm (`assets/fonts/`, để hiện đúng dấu tiếng Việt).
     - Bản có chữ lưu thẳng vào key cố định `covers/{novel}/{uuid}.webp`; bản không chữ lưu ở `covers/candidates/{job}/0-clean.webp` (sẽ hết hạn).
- Ảnh **được áp dụng làm bìa ngay** khi render xong (job `applied`, audit `NOVEL_COVER_AI_APPLIED`), bìa cũ bị xoá. Nếu truyện đã có bìa, CMS hỏi xác nhận trước khi thay.
- Job tạo từ import không bao giờ ghi đè bìa được upload trong lúc đang render: ảnh khi đó được giữ ở trạng thái `ready` để editor tự bấm áp dụng.
- Mỗi truyện chỉ có 1 job đang chạy (`409 COVER_JOB_IN_PROGRESS`).
  - Job kẹt quá 15 phút được đánh dấu `failed` ở lần tạo job kế tiếp.
  - Giới hạn 30 job/giờ cho mỗi admin.
  - Thiếu `DEEPSEEK_API_KEY` hoặc `CLOUDFLARE_AI_API_TOKEN` thì trả 503 `COVER_AI_NOT_CONFIGURED`.
- Bật `COVER_AI_AUTO_ON_IMPORT=true` để commit import tự tạo bìa AI cho các truyện mới chưa có bìa (EPUB/ZIP có bìa thì bỏ qua).
- R2: thêm lifecycle rule xoá prefix `covers/candidates/` sau 7 ngày.

### Import (`import/`)
- Thêm `@fastify/multipart` (đăng ký chỉ trong scope admin, giới hạn 50MB/file), file gốc lưu S3 `imports/{job_id}`.
- Luồng 2 bước (theo mẫu staging của catalog `src/modules/catalog/catalog.service.ts:332-457`):
  1. `POST /admin/novels/imports` (multipart: file, format?, mode, target_novel_id?, chapter_pattern?) → tạo job → BullMQ queue `novel-import` (đăng ký trong `src/jobs/index.ts`, chạy ở worker).
  2. Worker parse → ghi `novel_import_chapters` + `preview` (metadata nhận diện, số chương, số chữ, cảnh báo: chương rỗng/quá ngắn/trùng số/lỗi encoding) → status `ready`.
  3. Admin xem preview, chỉnh metadata → `POST /admin/novels/imports/:id/commit` → transaction ghi `novels`/`novel_chapters` (mode `new` / `append` sau chương cuối / `replace` theo chapter_no), cập nhật `chapter_count`/`word_count`, audit log.
- Parser:
  - **TXT/MD**: tự nhận UTF-8/UTF-16/Windows-1258 (`iconv-lite`), tách chương bằng regex mặc định (`^(Chương|Chapter|第)\s*\d+…`) hoặc pattern admin nhập.
  - **EPUB**: `jszip` đọc OPF + spine/nav → mỗi item = 1 chương; HTML → text (`node-html-parser`), lấy metadata (title/author/description) + ảnh bìa (upload S3). Ảnh trong nội dung bị bỏ.
  - **DOCX**: `mammoth` → text, tách chương theo Heading 1/2 hoặc regex.
  - **JSON/ZIP**: định dạng chuẩn của hệ thống (`novel.json` + `chapters/*.md` + `cover.*`) — cũng là định dạng export, dùng để backup/chuyển môi trường, cho phép nhiều truyện trong 1 ZIP.
- Nội dung lưu dạng **plain text, đoạn cách nhau bằng dòng trống** (đã sanitize), `word_count` tính khi lưu.

### Export (`export/`)
- `GET /admin/novels/:id/export?format=json|zip|epub|txt` — stream (`Content-Disposition: attachment`), ZIP/EPUB build bằng `jszip`.
- `GET /admin/novels/export.csv` — danh sách truyện + thống kê (cho báo cáo).

### Admin API (`admin-routes.ts`)
Theo mẫu `src/modules/catalog/admin-routes.ts`: `createAdminGuard(roles)` + `createAdminCsrfGuard()` (`src/plugins/admin-guard.ts`) cho mọi mutation, TypeBox schema, keyset pagination, audit log `NOVEL_*` vào `audit_log`, `AppError` cho lỗi.
- Novels: list (lọc/tìm/sort), get, create, update, delete (soft → `archived`), bulk (publish/hide/archive/gán category/set featured), upload cover.
- Ảnh bìa AI (editor/superadmin):
  - `POST /admin/novels/:id/cover-jobs` với body `{prompt?}`, trả 202 kèm job.
  - `GET /admin/novels/:id/cover-jobs/latest` trả `{job}`, trong đó có danh sách candidates (`url`, `clean_url`, `applied_at`).
  - `POST /admin/novel-cover-candidates/:id/apply` trả novel.
- Chapters: list (TOC), get, create, update (ghi revision), delete, reorder/renumber, bulk set VIP/giá/publish, xem revisions + khôi phục.
- Categories: CRUD + sắp xếp.
- Imports: tạo, list, get (preview + lỗi), commit, huỷ.
- Export như trên.
- Settings: `GET/PUT /admin/novel/settings[/:region_id]` (port từ `drama/admin.service.ts` `updateDramaSettings`).
- Stats: `GET /admin/novels/:id/stats`, `GET /admin/novels/stats/top`.
- Role mới **`editor`** (quản lý nội dung, không đụng tiền/user). Quyền: content = `editor, superadmin`; settings thưởng = `superadmin`; stats = thêm `analyst`. Cho phép `editor` đăng nhập CMS (`src/modules/admin/session-routes.ts:22`).

## 3. CMS (admin SPA) — tính năng đề xuất

Code mới đặt trong **`admin/src/novels.ts`** (+ `admin/src/novels-api.ts`) thay vì nhồi thêm vào `main.ts` 2.6k dòng; `main.ts` chỉ thêm `Page 'novels'`, tab trong `allTabs`, nhánh `loadPage`/`render`, reset state khi logout (theo mẫu catalog `admin/src/main.ts:1704-1929`). API client dùng `api<T>()` có sẵn (`admin/src/api.ts:544`, tự gắn CSRF).

**P1 — bắt buộc**
1. **Danh sách truyện**: tìm theo tên/tác giả, lọc trạng thái/thể loại/hoàn thành/ngôn ngữ/region, sort, phân trang; chọn nhiều → publish/ẩn/lưu trữ/gán thể loại/featured.
2. **Trình sửa truyện**: metadata, upload ảnh bìa (preview), thể loại/tag, region, chính sách VIP (N chương đầu free, giá mặc định, cho phép mở bằng ads).
3. **Quản lý chương**: bảng mục lục, thêm/sửa (editor textarea + preview, đếm chữ), xoá, đổi thứ tự/đánh lại số, chọn nhiều → đặt VIP/giá/publish, lên lịch `publish_at`, nháp/xuất bản, lịch sử chỉnh sửa + khôi phục.
4. **Import wizard**: chọn file + định dạng + chế độ (truyện mới/thêm chương/thay thế) → theo dõi job → preview (danh sách chương, số chữ, cảnh báo, xem nhanh nội dung) → sửa metadata → xác nhận.
5. **Export**: JSON/ZIP (backup), EPUB, TXT cho từng truyện; CSV danh sách truyện.
6. **Thể loại**: CRUD, sắp xếp, bật/tắt.
7. **Cài đặt thưởng đọc theo region**: thay form drama (`dramaSection` `admin/src/main.ts:2314`), thêm placement `chapter_unlock` vào trang rewarded ads.
8. **Audit log**: các hành động `NOVEL_*` hiện trong trang audit có sẵn.

**P2 — nên có**
9. **Thống kê**: người đọc, lượt đọc xong, tỉ lệ rơi theo chương (từ `novel_read_progress`), lượt mở khoá coin/ads, coin mint (thưởng) vs coin tiêu (unlock) theo truyện; top truyện.
10. **Trang chủ app**: chọn truyện featured + thứ tự hiển thị.
11. **Kiểm tra chất lượng nội dung**: cảnh báo chương rỗng/quá ngắn/trùng/nhảy số, lỗi encoding.
12. **Thông báo chương mới** qua inbox có sẵn cho user có truyện trong tủ.

**P3 — sau này**: đánh giá/bình luận + kiểm duyệt, đặt lịch publish hàng loạt theo ngày, nhiều tác giả/dịch giả có trang riêng.

## 4. Xoá drama

- Xoá `src/modules/drama/`, đăng ký trong `src/app.ts:24-25,225-226`.
- Config: bỏ `drama` khỏi `config.service.ts:8,16,118` và `config/schemas.ts:8`.
- CMS: bỏ `DramaRegionSettings`/`getDramaSettings`/`updateDramaSettings` (`admin/src/api.ts:169-180,702-715`) và mọi chỗ drama trong `main.ts` (`:17,45,62,142,186,392,2314-2350,2363,2449,2522-2545,2605-2618,2646`).
- Env: bỏ `DRAMA_PLAYBACK_SECRET`, `DRAMA_PLAYBACK_BASE_URL` (`src/config/env.ts:43-44,92-93`, `.env*.example`).
- Ledger: giữ `DRAMA_WATCH_CREDIT`/`EPISODE_UNLOCK_DEBIT` trong `types.ts` + `entry-labels.ts` (lịch sử); thêm nhãn cho `NOVEL_READ_CREDIT`, `CHAPTER_UNLOCK_DEBIT` (và `DIRECT_CREDIT` đang thiếu).
- Test: xoá `drama-heartbeat.test.ts`, `drama-settings-admin.test.ts` (port kịch bản sang novel).
- README, `package.json` description: "read-to-earn novel".

## 5. Thứ tự thực hiện

1. Migrations 065–067 + `db/types.ts` + ledger types/labels.
2. Module novel: đọc + heartbeat thưởng + unlock (coin/ad) + `/config` + xoá drama → test.
3. Admin API: novels/chapters/categories/settings/stats + role `editor` → test.
4. Storage S3 + upload bìa; import (multipart, queue, parsers, staging, commit); export → test với file mẫu.
5. CMS SPA: các trang P1, sau đó P2.
6. Cập nhật README/env example/docker-compose (MinIO); viết `docs/USER_FLOWS.md` (nội dung §6).
7. Bản sửa bảo mật §7.2 (mục 1–5 làm trước bước 2), phần hạ tầng §7.4.

> Lưu ý: app mobile phải cập nhật theo API mới (`/novels/*`, `features.novel`, placement `chapter_unlock`); API drama cũ sẽ trả 404.

## 6. Tài liệu luồng người dùng — sẽ lưu thành `docs/USER_FLOWS.md`

### 6.1 Tổng quan vòng đời coin

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

### 6.2 Luồng chi tiết

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

## 7. Chống hack / gian lận / DDoS

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

## 8. Verification

- `pnpm install && pnpm typecheck && pnpm lint && pnpm admin:typecheck`.
- `docker-compose up -d` (Postgres, Redis, MinIO) → `pnpm migrate:up` → kiểm tra `migrate:down` 3 bước rồi `up` lại.
- Integration tests mới (real Postgres/Redis, mẫu `app.inject` + `adminHeaders`):
  - `novel-reading.test.ts`: beat đầu baseline; không đủ thời gian/cuộn không thưởng; thưởng đúng 1 lần; chương VIP/không tồn tại/chưa publish không thưởng; 2 chương song song chỉ 1 được tính; trần ngày dưới request đồng thời; trần unbacked 20k; account banned; region tắt; `/config` có `features.novel`.
  - `novel-unlock.test.ts`: mở bằng coin (trừ đúng, idempotent, thiếu coin → lỗi); mở bằng ad (intent đúng placement, sai owner, placement NULL/khác bị từ chối, intent dùng 2 lần bị từ chối); đọc chương khoá → `CHAPTER_LOCKED`.
  - `novel-admin.test.ts`: CRUD, bulk, role (`editor` được, `fulfillment` 403), thiếu CSRF 403, audit log ghi đúng.
  - `novel-import-export.test.ts`: fixture nhỏ EPUB/DOCX/TXT/JSON-ZIP → preview đúng số chương → commit 3 chế độ → export ZIP rồi import lại cho kết quả giống hệt (round-trip).
- Test cho bản sửa §7.2: reversal khi còn hold không bị release lại; spin/unlock từ chối intent placement NULL; SSV từ chối `ad_unit` lạ; guest mới không có welcome coin available; redemption đồng thời không vượt trần tuần; user banned không được credit postback.
- `pnpm test` toàn bộ (các module coin cũ không đổi phải vẫn xanh).
- Thủ công: `pnpm dev` + `pnpm dev:worker` + `pnpm admin:dev` → đăng nhập CMS, import 1 EPUB thật, sửa chương, đặt VIP, export; dùng curl gọi `/novels/*`, heartbeat tới khi nhận coin, mở khoá chương bằng coin.

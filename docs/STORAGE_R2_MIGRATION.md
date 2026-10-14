# Chuyển lưu trữ ảnh bìa và file import từ SeaweedFS sang Cloudflare R2

Production hiện lưu ảnh bìa truyện (`covers/…`) và file import (`imports/…`) trên SeaweedFS chạy trong `docker-compose.prod.yml`. Host nginx phục vụ ảnh qua `<API domain>/media/…`. Code đã dùng chuẩn S3 nên R2 chỉ là đổi cấu hình `S3_*`. Phần việc chính là copy dữ liệu cũ và đổi `novels.cover_url`. Cột này lưu URL tuyệt đối theo địa chỉ public cũ.

Không cần downtime: URL cũ vẫn chạy cho tới khi tắt SeaweedFS ở bước cuối.

## 1. Chuẩn bị R2 (Cloudflare dashboard)

1. **R2 → Create bucket**, ví dụ `ainovel`.
2. **Bucket → Settings → Public access**: gắn custom domain (khuyến nghị, ví dụ `media.<domain>`, có cache CDN) hoặc bật `r2.dev` URL (chỉ nên dùng thử). URL này là `S3_PUBLIC_BASE_URL`.
3. **R2 → Manage API tokens → Create API token**: quyền **Object Read & Write**, giới hạn đúng bucket trên. Ghi lại Access Key ID, Secret Access Key và endpoint `https://<account-id>.r2.cloudflarestorage.com`.

## 2. Deploy bản code có hỗ trợ R2

Merge vào `main` để CI deploy. Bản này:

- Cấu hình AWS SDK tương thích R2 (`requestChecksumCalculation` / `responseChecksumValidation` = `WHEN_REQUIRED`).
- Thêm lệnh `node dist/cli/migrate-object-storage.js` để copy dữ liệu và viết lại `cover_url`.
- Cho SeaweedFS dùng khoá riêng `SEAWEEDFS_ACCESS_KEY_ID` / `SEAWEEDFS_SECRET_ACCESS_KEY`. Nếu không đặt thì vẫn dùng `S3_*` như trước, nên deploy bước này không đổi hành vi.

## 3. Đổi `.env.production` trên server

Theo thứ tự này. **Bước a phải làm trước bước b**, nếu không, lần khởi động sau SeaweedFS sẽ nhận khoá R2 và script không đọc được dữ liệu cũ.

a. Thêm khoá cũ của SeaweedFS (chính là giá trị `S3_*` hiện tại):

```env
SEAWEEDFS_ACCESS_KEY_ID=<S3_ACCESS_KEY_ID hiện tại>
SEAWEEDFS_SECRET_ACCESS_KEY=<S3_SECRET_ACCESS_KEY hiện tại>
```

b. Đổi `S3_*` sang R2. Ghi lại `S3_PUBLIC_BASE_URL` cũ để dùng ở bước 4.

```env
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=ainovel
S3_ACCESS_KEY_ID=<R2 access key id>
S3_SECRET_ACCESS_KEY=<R2 secret access key>
S3_FORCE_PATH_STYLE=false
S3_PUBLIC_BASE_URL=https://media.<domain>
```

c. Khởi động lại API và worker để file upload mới đi thẳng vào R2:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --force-recreate backend-api backend-worker
```

Từ lúc này ảnh mới nằm trên R2. Ảnh cũ vẫn được phục vụ từ SeaweedFS qua URL cũ.

## 4. Copy dữ liệu cũ sang R2

Chạy trong mạng compose để gọi được `seaweedfs:8333`. Chạy `--dry-run` trước để xem số file và số `cover_url` sẽ đổi:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e SOURCE_S3_ENDPOINT=http://seaweedfs:8333 \
  -e SOURCE_S3_BUCKET=ainovel \
  -e SOURCE_S3_ACCESS_KEY_ID=<khoá SeaweedFS> \
  -e SOURCE_S3_SECRET_ACCESS_KEY=<secret SeaweedFS> \
  -e SOURCE_S3_FORCE_PATH_STYLE=true \
  -e SOURCE_S3_PUBLIC_BASE_URL=<S3_PUBLIC_BASE_URL cũ, vd https://api.<domain>/media> \
  --no-deps backend-api node dist/cli/migrate-object-storage.js --dry-run
```

Bỏ `--dry-run` để chạy thật. Script:

- Copy mọi object, giữ nguyên `Content-Type` và `Cache-Control`. Object đã có trên R2 với cùng kích thước thì bỏ qua, nên chạy lại bao nhiêu lần cũng được.
- Nếu có file copy lỗi: in danh sách, **không** đổi `cover_url`, thoát với mã 1. Sửa lỗi rồi chạy lại.
- Nếu mọi file đều ổn: đổi các `cover_url` bắt đầu bằng URL cũ sang URL R2. URL ảnh ngoài do admin dán tay không bị đụng tới.

Chạy lại lần nữa sau khi xong. Lần chạy lại phải báo `0 copied` và `0 cover URL(s) moved`, nghĩa là không còn file upload trong lúc chuyển bị sót.

## 5. Kiểm tra

- Mở vài truyện trong CMS và app: ảnh bìa tải từ domain R2.
- Upload thử một ảnh bìa trong CMS, rồi import thử một file.
- Kiểm tra trong DB không còn URL cũ:

```sql
SELECT count(*) FROM novels WHERE starts_with(cover_url, '<URL cũ>/');
```

## 6. Gỡ SeaweedFS (sau khi chạy ổn vài ngày)

Đây là một thay đổi code riêng, chỉ làm sau khi bước 5 đã ổn:

- Xoá service `seaweedfs` và volume `seaweeddata_prod` khỏi `docker-compose.prod.yml`, và bỏ `seaweedfs` khỏi lệnh `up -d postgres redis seaweedfs` trong `.github/workflows/ci-main.yml`. Deploy chạy `--remove-orphans`, nên container SeaweedFS sẽ bị gỡ ngay ở lần deploy đó.
- Xoá `SEAWEEDFS_*` và `FILER_PORT` khỏi `.env.production`.
- Xoá block `location /media/` trỏ tới filer trong nginx trên host.
- Giữ lại volume Docker `be-ainovel_seaweeddata_prod` thêm một thời gian để có đường lui, sau đó mới xoá bằng `docker volume rm`.

Môi trường dev (`docker-compose.yml`) vẫn dùng SeaweedFS local, không cần tài khoản R2.

## Quay lại nếu có sự cố

Trước bước 6, dữ liệu trên SeaweedFS vẫn còn nguyên. Để quay lại:

1. Trả `S3_*` về giá trị cũ, rồi khởi động lại `backend-api` và `backend-worker`.
2. Chạy lại script theo chiều ngược: nguồn là R2, đích là SeaweedFS. Script vừa copy các file mới upload lên R2 về SeaweedFS, vừa trả `cover_url` về URL cũ.

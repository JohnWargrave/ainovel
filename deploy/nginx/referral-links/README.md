# Referral links with Nginx

Nginx owns the public referral-link host. No Cloudflare Worker or Wrangler is required.

It serves:

- `/.well-known/assetlinks.json` for Android App Links verification.
- `/r/HP-XXXXXX` as a redirect to Google Play with the Install Referrer value.
- `/r?code=HP-XXXXXX` as compatibility for previously shared query-style links.

## Render

```sh
export REFERRAL_LINK_HOST=link.ainovel.com
export GOOGLE_PLAY_PACKAGE_NAME=com.example.ainovel
export ANDROID_SHA256_CERT_FINGERPRINT=AA:BB:...:FF

./deploy/nginx/referral-links/render.sh /tmp/ainovel-referral-links
```

The command produces:

```text
/tmp/ainovel-referral-links/conf.d/referral-links.conf
/tmp/ainovel-referral-links/www/assetlinks.json
```

Copy the config into the Nginx `http` configuration and keep the rendered `www` directory at the
absolute path written into the config. Alternatively, mount both paths into an Nginx container.

TLS must cover `REFERRAL_LINK_HOST`. It can terminate in this Nginx instance or in the existing
load balancer/tunnel in front of it. The public URL must remain HTTPS for Android App Links.

After `nginx -t` and reload, set the backend environment:

```env
REFERRAL_SHARE_BASE_URL=https://link.ainovel.com/r
```

Verify:

```sh
curl -i https://link.ainovel.com/.well-known/assetlinks.json
curl -I https://link.ainovel.com/r/HP-9HCW9E
```

Run the renderer and Nginx syntax test locally with:

```sh
./deploy/nginx/referral-links/test.sh
```

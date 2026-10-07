# Public marketing site — apps/web, a Next.js static export (`output: "export"`).
# turbo build (scripts/deploy.sh) writes it to apps/web/out; nginx serves the files
# directly, so there is no Node process or pm2 entry for this site.
# Install once with scripts/setup-website.sh.

server {
    listen 443 ssl;
    server_name digitalsukoon.com;
    ssl_certificate /etc/ssl/cloudflare-cert.pem;
    ssl_certificate_key /etc/ssl/cloudflare-key.pem;

    root /opt/dashmani-platform/apps/web/out;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml text/plain application/xml;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    # Hashed build assets never change under the same name.
    location /_next/static/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location / {
        # HTML must be re-fetched after each deploy so it points at the new asset hashes.
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        try_files $uri $uri.html $uri/ =404;
    }

    error_page 404 /404.html;
}

server {
    listen 443 ssl;
    server_name www.digitalsukoon.com;
    ssl_certificate /etc/ssl/cloudflare-cert.pem;
    ssl_certificate_key /etc/ssl/cloudflare-key.pem;
    return 301 https://digitalsukoon.com$request_uri;
}

server {
    listen 80;
    server_name digitalsukoon.com www.digitalsukoon.com;
    return 301 https://digitalsukoon.com$request_uri;
}

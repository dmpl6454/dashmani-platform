# Creator portal — apps/creators, a Next.js static export (`output: "export"`).
# turbo build (scripts/deploy.sh) writes it to apps/creators/out; nginx serves the files
# directly, so there is no Node process or pm2 entry for this site. Every page talks to the
# API at https://api.digitalsukoon.com/v1 (baked in at build time from apps/creators/.env.local).
# Install once with scripts/setup-creators.sh.

server {
    listen 443 ssl;
    server_name creators.digitalsukoon.com;
    ssl_certificate /etc/ssl/cloudflare-cert.pem;
    ssl_certificate_key /etc/ssl/cloudflare-key.pem;

    root /opt/dashmani-platform/apps/creators/out;
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
        # HTML must be re-fetched after each deploy so it points at the new asset hashes, and the
        # signed-in pages must never sit in a shared cache. (An `add_header` inside a location
        # replaces the server-level ones, so they are repeated here.)
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        # /login → login.html, /connect?error=denied → connect.html (static export, no dynamic routes).
        try_files $uri $uri.html $uri/ =404;
    }

    error_page 404 /404.html;
}

server {
    listen 80;
    server_name creators.digitalsukoon.com;
    return 301 https://creators.digitalsukoon.com$request_uri;
}

server {
    listen 443 ssl;
    server_name jobs.digitalsukoon.com;
    ssl_certificate /etc/ssl/cloudflare-cert.pem;
    ssl_certificate_key /etc/ssl/cloudflare-key.pem;
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header CDN-Cache-Control "no-store" always;
    }
    location /_next/static/ {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host $host;
    }
}

server {
    listen 80;
    server_name jobs.digitalsukoon.com;
    return 301 https://$host$request_uri;
}

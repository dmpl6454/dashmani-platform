#!/bin/bash
# =============================================================
# Security Hardening Script for Dashmani Platform
# Run once on server setup, review periodically
# =============================================================

echo "=== Digital Sukoon Security Hardening ==="

# 1. UFW Firewall setup
echo "Setting up firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
echo "Firewall configured: SSH, HTTP, HTTPS allowed"

# 2. Fail2ban for brute force protection
echo "Setting up fail2ban..."
apt-get install -y fail2ban > /dev/null 2>&1

cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = ssh
maxretry = 3
bantime = 7200

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true

[nginx-limit-req]
enabled = true
EOF

systemctl restart fail2ban
echo "Fail2ban configured"

# 3. Nginx security headers (add to existing config)
echo "Adding nginx security settings..."
cat > /etc/nginx/conf.d/security.conf << 'EOF'
# Block common attack patterns
map $request_uri $block_request {
    default 0;
    ~*\.(env|git|svn|htaccess|htpasswd|ini|log|bak|old|sql|swp|tmp)$ 1;
    ~*(wp-admin|wp-login|xmlrpc|phpmyadmin|adminer|phpinfo) 1;
    ~*(eval|base64_decode|exec|system|passthru|shell_exec) 1;
}

# Limit request body size (>= API express.json 10mb limit, with headroom for large link batches)
client_max_body_size 25m;

# Connection timeouts — header timeout stays tight; body/send raised so large
# daily-report submissions are not cut mid-upload/mid-response.
client_body_timeout 120;
client_header_timeout 10;
send_timeout 120;
keepalive_timeout 65;
EOF

# 4. Nginx rate limiting
cat > /etc/nginx/conf.d/rate-limit.conf << 'EOF'
# Rate limiting zones
limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;
limit_conn_zone $binary_remote_addr zone=addr:10m;
EOF

# 5. Secure SSH
echo "Hardening SSH..."
sed -i 's/#PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config 2>/dev/null
sed -i 's/#MaxAuthTries 6/MaxAuthTries 3/' /etc/ssh/sshd_config 2>/dev/null
sed -i 's/#LoginGraceTime 2m/LoginGraceTime 30/' /etc/ssh/sshd_config 2>/dev/null
systemctl restart sshd

# 6. Automatic security updates
echo "Setting up automatic security updates..."
apt-get install -y unattended-upgrades > /dev/null 2>&1
dpkg-reconfigure -plow unattended-upgrades 2>/dev/null

# 7. Verify nginx config and reload
nginx -t && systemctl reload nginx

echo ""
echo "=== Security Hardening Complete ==="
echo ""
echo "Active protections:"
echo "  - UFW firewall (SSH, HTTP, HTTPS only)"
echo "  - Fail2ban (SSH brute force protection)"
echo "  - Nginx rate limiting & request filtering"
echo "  - Strict CORS, CSP, Helmet headers in API"
echo "  - Auth endpoint rate limiting (20/15min)"
echo "  - SSH hardened (max 3 auth attempts)"
echo "  - Automatic security updates enabled"
echo ""
echo "Monitoring:"
echo "  - fail2ban-client status           # Check ban status"
echo "  - ufw status verbose               # Firewall rules"
echo "  - tail -f /var/log/fail2ban.log    # Ban logs"

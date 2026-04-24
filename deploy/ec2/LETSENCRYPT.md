# Trusted HTTPS on EC2 (Let’s Encrypt)

You cannot get a **publicly trusted** certificate for a **bare public IP** with Let’s Encrypt. You need a **hostname** that resolves to the instance.

## Option A: sslip.io / nip.io (no registrar)

Services like **[sslip.io](https://sslip.io)** and **[nip.io](https://nip.io)** map a name that **embeds your IP** to that address, so you get a hostname without creating your own DNS zone.

**Example** for instance `54.169.70.247` (dots → hyphens in the left label):

- Hostname: **`54-169-70-247.sslip.io`**
- It should resolve to your IP: `dig +short 54-169-70-247.sslip.io`

Use that exact name as `DOMAIN` in `letsencrypt-bootstrap.sh` and as your public API base (`https://54-169-70-247.sslip.io`, no trailing slash). Prefer **dash** form for IPv4 so the name is a single cert SAN label (works well with Certbot).

**Caveats:** Some networks block “DNS rebinding” style names; if resolution fails, use a real domain (Option B). nip.io parsing rules can differ by format—when in doubt, use the dash form with sslip.io.

## 1. DNS (Option B: your own domain)

- Create: `A` record → e.g. `ride-api` → your EC2 public IP.
- Wait until it resolves: `dig +short ride-api.yourdomain.com` shows that IP.
- **Security group:** allow inbound **TCP 80** and **443** from the internet (HTTP-01 needs port 80).

## 2. On the instance

After the app has been deployed at least once (so nginx config exists):

```bash
cd ~/grab-hackathon-2026/deploy/ec2
# Option A (sslip):
# sudo DOMAIN=54-169-70-247.sslip.io CERTBOT_EMAIL=you@example.com ./letsencrypt-bootstrap.sh
# Option B (your domain):
sudo DOMAIN=ride-api.yourdomain.com CERTBOT_EMAIL=you@example.com ./letsencrypt-bootstrap.sh
```

The script:

- Installs `certbot` (Amazon Linux), obtains a cert via **HTTP-01** to `/var/www/certbot` (already wired in `ride-comfort.nginx.conf`),
- Switches nginx to `/etc/letsencrypt/live/<DOMAIN>/` for the certificate and key,
- Installs a **renewal hook** so `nginx` reloads when certbot renews the cert.

## 3. Use the hostname everywhere

- Test: `curl -fsS "https://ride-api.yourdomain.com/health"` (no `-k`).

Browsers and tools must use **`https://<hostname>/...`**, not the raw IP, or TLS will still complain (name on the cert does not match the IP).

- On Vercel: set `RIDE_API_UPSTREAM=https://ride-api.yourdomain.com` and **remove** `RIDE_API_TLS_INSECURE=1` if you only added that for the self-signed IP.

## 4. Renewals

Certbot usually installs a **systemd timer** or **cron** job. The deploy hook in the script runs `systemctl reload nginx` after each successful renewal. Verify with:

```bash
sudo certbot renew --dry-run
```

## Troubleshooting

- **Connection refused on port 80:** open the security group, confirm nginx: `curl -I http://ride-api.yourdomain.com/`.
- **Invalid response / challenge failed:** DNS must point to **this** server; no CDN in front of port 80 for that hostname unless you use DNS challenge instead of this script.
- Nginx config backup: `ride-comfort.conf.bak.letsencrypt.*` next to the active file in `/etc/nginx/conf.d/`.

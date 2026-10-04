# GoDaddy DNS — TRAC51

Keep `tracmy.org` and your existing email exactly as they are.

The conference uses only a subdomain:

`trac51.tracmy.org`

## Railway gives you two DNS records

When you add `trac51.tracmy.org` as a Railway custom domain, Railway will provide:

1. A **CNAME** record for routing traffic.
2. A **TXT** record for domain verification.

Both are required by Railway.

## GoDaddy

Go to:

**GoDaddy → Domain Portfolio → tracmy.org → DNS → Add New Record**

For the CNAME:

- Type: `CNAME`
- Name: `trac51`
- Value: use the exact Railway CNAME target shown in Railway
- TTL: Default

For the TXT record:

- Type: `TXT`
- Name: use the exact Railway TXT name shown in Railway
- Value: use the exact Railway verification value shown in Railway
- TTL: Default

Do not edit:

- `@`
- `www`
- MX records
- existing SPF/DKIM records

DNS propagation can take time. Railway will show when the custom domain is verified and its TLS certificate is active.

# Account verification and recovery

Configure an onboarded Cloudflare Email Service sender domain, the `EMAIL` binding, `EMAIL_FROM`, and optionally `EMAIL_FROM_NAME`. Update each Wrangler configuration's allowed sender address to match the verified domain. Missing service configuration produces `EMAIL_NOT_CONFIGURED`; a failed send produces `EMAIL_SEND_FAILED`.

Users set an email address and resend its verification link from personal security settings. Set `ROOT_REQUIREMENTS=email` to require verification before community operations. The verification and recovery links are opaque, stored only as hashes, single-use, and expiring. Password recovery requires a verified email attached to an active account.

Set both `TURNSTILE_SITE_KEY` and the Worker secret `TURNSTILE_SECRET_KEY` to enforce Turnstile on registration and account-action requests. `TURNSTILE_ALLOWED_HOSTNAMES` restricts accepted hostnames. The backend validates success, hostname, and action; configuring only one key fails closed. Keep the secret in Worker Secrets or an ignored local `.dev.vars` file.

An operator with D1 access can issue a recovery link:

```sh
node scripts/account-reset.mjs --username example --origin https://instance.example
```

Use `--database` and `--config server/wrangler.stardust.jsonc` for a different configured deployment. The link expires in fifteen minutes. The CLI does not bypass the verified-email requirement. Local recovery and email mutation are disabled when the instance requires SSO; use the identity provider's recovery workflow.

Successful password reset changes the password and revokes previous HTTP sessions, pending authentication challenges, room tokens, and existing sockets. Room and tips handshakes recheck account state and current permissions. The ownership key remains encrypted under its existing ownership passphrase; resetting the login password cannot recover a lost ownership passphrase.

For local development without production email access, run `wrangler dev --local`. Test runs explicitly disable remote bindings.

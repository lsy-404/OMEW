// Augments the wrangler-generated Env (worker-configuration.d.ts) with vars that
// aren't declared in wrangler.jsonc - DEV_TOKEN_SECRET lives in .dev.vars locally
// and `wrangler secret put` in deployed environments, see .dev.vars.example.
// No imports/exports here on purpose: this must stay an ambient script file so
// the top-level `interface Env` merges with the generated global one.

interface Env {
  DEV_TOKEN_SECRET: string;
  SSO_MODE?: string;
  SSO_ISSUER?: string;
  SSO_CLIENT_ID?: string;
  SSO_CLIENT_SECRET?: string;
  SSO_PROVIDER_NAME?: string;
  INSTANCE_MODE?: string;
  ROOT_STRONGHOLD?: string;
  INSTANCE_LOGO_URL?: string;
  ENABLE_EMOTES?: string;
  USE_BUILTIN_EMOTES?: string;
  ENABLE_REACTIONS?: string;
  USE_ART_ASSETS?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

declare namespace Cloudflare {
  interface Env {
    DEV_TOKEN_SECRET: string;
    SSO_MODE?: string;
    SSO_ISSUER?: string;
    SSO_CLIENT_ID?: string;
    SSO_CLIENT_SECRET?: string;
    SSO_PROVIDER_NAME?: string;
    INSTANCE_MODE?: string;
    ROOT_STRONGHOLD?: string;
    INSTANCE_LOGO_URL?: string;
    ENABLE_EMOTES?: string;
    USE_BUILTIN_EMOTES?: string;
    ENABLE_REACTIONS?: string;
    USE_ART_ASSETS?: string;
    CF_API_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
  }
}

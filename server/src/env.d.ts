// Augments the wrangler-generated Env (worker-configuration.d.ts) with vars that
// aren't declared in wrangler.jsonc - DEV_TOKEN_SECRET lives in .dev.vars locally
// and `wrangler secret put` in deployed environments, see .dev.vars.example.
// No imports/exports here on purpose: this must stay an ambient script file so
// the top-level `interface Env` merges with the generated global one.

interface Env {
  DEV_TOKEN_SECRET: string;
  STAR_DUST_SSO_SECRET?: string;
  FIXED_STRONGHOLD?: string;
  INSTANCE_LOGO_URL?: string;
  ENABLE_EMOTES?: string;
  ENABLE_REACTIONS?: string;
  USE_ART_ASSETS?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

declare namespace Cloudflare {
  interface Env {
    DEV_TOKEN_SECRET: string;
    STAR_DUST_SSO_SECRET?: string;
    FIXED_STRONGHOLD?: string;
    INSTANCE_LOGO_URL?: string;
    ENABLE_EMOTES?: string;
    ENABLE_REACTIONS?: string;
    USE_ART_ASSETS?: string;
    CF_API_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later

const ROOT_STRONGHOLD_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function deploymentInputs(inputs = {}) {
  const instanceMode = trimmed(inputs.instance_mode) || "multi";
  const rootStronghold = trimmed(inputs.root_stronghold);
  if (!['multi', 'single'].includes(instanceMode)) throw new Error("Invalid instance mode");
  if (instanceMode === "single" && !ROOT_STRONGHOLD_RE.test(rootStronghold)) {
    throw new Error("A valid root stronghold slug is required in single mode");
  }

  const ssoMode = trimmed(inputs.sso_mode) || "disabled";
  if (!["disabled", "optional", "required"].includes(ssoMode)) throw new Error("Invalid single sign-on mode");
  const issuer = trimmed(inputs.sso_issuer);
  const clientId = trimmed(inputs.sso_client_id);
  const clientSecret = typeof inputs.sso_client_secret === "string" ? inputs.sso_client_secret : "";
  if (ssoMode !== "disabled") {
    if (!issuer || !clientId || !clientSecret) throw new Error("OIDC configuration is incomplete");
    let issuerUrl;
    try {
      issuerUrl = new URL(issuer);
    } catch {
      throw new Error("OIDC issuer must be a valid HTTPS URL");
    }
    if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
      throw new Error("OIDC issuer must be a valid HTTPS URL");
    }
  }
  return { instanceMode, rootStronghold, ssoMode, clientSecret };
}

export async function deploy(ctx) {
  const { workerName, domain, inputs } = ctx.ctx;
  const settings = deploymentInputs(inputs);

  await ctx.step("storage", "running");
  await ctx.d1.provision("db");
  await ctx.r2.provision("media");
  await ctx.step("storage", "success");

  await ctx.step("schema", "running");
  await ctx.d1.query("db", "CREATE TABLE IF NOT EXISTS overture_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const migrations = JSON.parse(await ctx.text("migrations/index.json"));
  if (ctx.ctx.mode === "overwrite") {
    const existing = await ctx.d1.query("db", "SELECT name FROM overture_migrations");
    if (!rowsOf(existing).length) {
      const tables = rowsOf(await ctx.d1.query(
        "db",
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'd1_migrations')",
      ));
      const tableNames = new Set(tables.map((row) => row.name));
      if (tableNames.has("d1_migrations")) {
        const legacy = rowsOf(await ctx.d1.query("db", "SELECT name FROM d1_migrations"));
        if (tableNames.has("users") && !legacy.length) {
          throw new Error("Existing OMEW database has no verifiable migration history");
        }
        for (const row of legacy) {
          if (typeof row.name === "string") {
            await ctx.d1.query(
              "db",
              "INSERT OR IGNORE INTO overture_migrations (name, applied_at) VALUES (?, unixepoch())",
              [row.name],
            );
          }
        }
      } else if (tableNames.has("users")) {
        throw new Error("Existing OMEW database has no verifiable migration history");
      }
    }
  }
  for (const name of migrations) {
    const applied = await ctx.d1.query("db", "SELECT name FROM overture_migrations WHERE name = ?", [name]);
    if (!rowsOf(applied).length) {
      await ctx.d1.query("db", await ctx.text(`migrations/${name}`));
      await ctx.d1.query("db", "INSERT INTO overture_migrations (name, applied_at) VALUES (?, unixepoch())", [name]);
    }
  }
  await ctx.step("schema", "success");

  await ctx.step("assets", "running");
  const assets = await ctx.assets.upload();
  await ctx.step("assets", "success");

  await ctx.step("worker", "running");
  const { versionId } = await ctx.worker.uploadVersion({ assets });
  await ctx.worker.switchTraffic(versionId);
  await ctx.step("worker", "success");

  if (domain) await ctx.domains.attach(domain);

  await ctx.step("secrets", "running");
  if (ctx.ctx.mode === "fresh" || ctx.ctx.fullRebuild) await ctx.secrets.put("DEV_TOKEN_SECRET", await ctx.crypto.randomBase64(48));
  await ctx.secrets.putHostValue("CF_ACCOUNT_ID");
  await ctx.secrets.putHostValue("CF_API_TOKEN");
  if (settings.ssoMode !== "disabled") await ctx.secrets.put("SSO_CLIENT_SECRET", settings.clientSecret);
  await ctx.step("secrets", "success");

  const url = domain ? `https://${domain}` : "";
  await ctx.result({
    url,
    notes: [
      `Worker ${workerName} deployed.`,
      settings.instanceMode === "single"
        ? `Single-stronghold mode uses ${settings.rootStronghold} at /.`
        : "Multi-stronghold mode is enabled.",
      settings.ssoMode === "disabled"
        ? "SSO is disabled; local authentication remains enabled."
        : `Register ${url || "the deployed hostname"}/api/auth/oidc/callback with the OIDC provider.`,
    ],
  });
}

function rowsOf(queryResult) {
  if (!Array.isArray(queryResult)) throw new Error("D1 returned an invalid query response");
  return queryResult.flatMap((result) => Array.isArray(result?.results) ? result.results : []);
}

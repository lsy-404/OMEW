import { describe, expect, it, vi } from "vitest";
import {
  buildAdminConfigBindings,
  updateWorkerInstanceConfig,
  validateAdminConfigPatch,
  type AdminConfigPatchField,
} from "../server/src/api";
import type { InstanceConfig } from "../server/src/types";

const CURRENT: InstanceConfig = {
  instance_mode: "multi",
  root_stronghold: null,
  allow_root: true,
  root_requirements: [],
  trusted_identity_servers: ["*"],
  max_file_bytes: 10_485_760,
  user_storage_quota_bytes: 209_715_200,
  federation_peers: [],
  stronghold_creation_policy: "open",
  stronghold_creators: [],
  allow_guest_browsing: true,
};

function managedEnv(): Env {
  return {
    CF_API_TOKEN: "secret-token",
    CF_ACCOUNT_ID: "account-id",
    CF_WORKER_NAME: "openmew",
  } as Env;
}

async function errorCode(result: Response | Partial<Record<AdminConfigPatchField, unknown>>): Promise<string | null> {
  if (!(result instanceof Response)) return null;
  return ((await result.json()) as { error: string }).error;
}

describe("admin config validation", () => {
  it("accepts the supported policy shape and keeps media quota above the file limit", () => {
    const result = validateAdminConfigPatch({
      allow_root: false,
      trusted_identity_servers: ["*", "identity.example"],
      federation_peers: ["peer.example"],
      stronghold_creators: ["@alice:local"],
      max_file_bytes: 4_000_000,
      user_storage_quota_bytes: 8_000_000,
    }, CURRENT);
    expect(result).not.toBeInstanceOf(Response);
  });

  it("allows wildcard only for trusted identity servers", async () => {
    expect(await errorCode(validateAdminConfigPatch({ federation_peers: ["*"] }, CURRENT))).toBe("CONFIG_INVALID");
    expect(await errorCode(validateAdminConfigPatch({ stronghold_creators: ["@alice:*"] }, CURRENT))).toBe("CONFIG_INVALID");
  });

  it("validates root and OIDC field shapes before the cross-field deployment check", async () => {
    expect(await errorCode(validateAdminConfigPatch({ instance_mode: "single" }, CURRENT))).toBeNull();
    expect(await errorCode(validateAdminConfigPatch({ sso_mode: "optional", sso_issuer: "not-a-url" }, CURRENT))).toBe("CONFIG_INVALID");
    expect(await errorCode(validateAdminConfigPatch({ sso_mode: "required", sso_issuer: "https://identity.example", sso_client_id: "omew" }, CURRENT))).toBeNull();
    const deployment = await updateWorkerInstanceConfig(managedEnv(), {
      SSO_MODE: "required",
      SSO_ISSUER: "https://identity.example",
      SSO_CLIENT_ID: "omew",
    }, vi.fn());
    expect(deployment.status).toBe(400);
    expect(await deployment.json()).toEqual({ error: "CONFIG_INVALID" });
  });

  it("rejects unknown fields, duplicate domains, and a quota below the file limit", async () => {
    expect(await errorCode(validateAdminConfigPatch({ unexpected: true }, CURRENT))).toBe("CONFIG_INVALID");
    expect(await errorCode(validateAdminConfigPatch({ federation_peers: ["peer.example", "peer.example"] }, CURRENT))).toBe("CONFIG_INVALID");
    expect(await errorCode(validateAdminConfigPatch({ max_file_bytes: 20, user_storage_quota_bytes: 10 }, CURRENT))).toBe("CONFIG_INVALID");
  });
});

describe("Cloudflare settings update", () => {
  it("inherits every untouched binding and never copies secret text", () => {
    const bindings = buildAdminConfigBindings(
      [
        { name: "DB" },
        { name: "CF_API_TOKEN" },
        { name: "ALLOW_ROOT" },
      ],
      { ALLOW_ROOT: false },
    );
    expect(bindings).toEqual([
      { name: "DB", type: "inherit", version_id: "latest" },
      { name: "CF_API_TOKEN", type: "inherit", version_id: "latest" },
      { name: "ALLOW_ROOT", type: "plain_text", text: "0" },
    ]);
    expect(JSON.stringify(bindings)).not.toContain("secret-token");
  });

  it("sends multipart settings with a bindings object and returns the pending config", async () => {
    let submittedSettings: unknown = null;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(init.headers).toEqual({ Authorization: "Bearer secret-token" });
        expect(init.body).toBeInstanceOf(FormData);
        const settingsPart = (init.body as FormData).get("settings");
        expect(settingsPart).toBeInstanceOf(Blob);
        submittedSettings = JSON.parse(await (settingsPart as Blob).text());
        return Response.json({ success: true, result: {} });
      }
      return Response.json({
        success: true,
        result: {
          bindings: [
            { name: "DB", type: "d1", id: "db-id" },
            { name: "MEDIA", type: "r2_bucket", bucket_name: "media" },
            { name: "CF_API_TOKEN", type: "secret_text" },
            { name: "ALLOW_ROOT", type: "plain_text", text: "1" },
          ],
        },
      });
    });

    const response = await updateWorkerInstanceConfig(managedEnv(), { ALLOW_ROOT: false }, fetcher);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allow_root: false, source: "env-pending" });
    expect(submittedSettings).toEqual({
      bindings: [
        { name: "DB", type: "inherit", version_id: "latest" },
        { name: "MEDIA", type: "inherit", version_id: "latest" },
        { name: "CF_API_TOKEN", type: "inherit", version_id: "latest" },
        { name: "ALLOW_ROOT", type: "plain_text", text: "0" },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when credentials or a successful Cloudflare envelope are missing", async () => {
    const missing = await updateWorkerInstanceConfig({} as Env, { ALLOW_ROOT: false }, vi.fn());
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "CONFIG_UPSTREAM_UNAVAILABLE" });

    const failedEnvelope = vi.fn(async () => Response.json({ success: false, errors: [{ message: "private upstream detail" }] }));
    const failed = await updateWorkerInstanceConfig(managedEnv(), { ALLOW_ROOT: false }, failedEnvelope);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "CONFIG_UPSTREAM_ERROR" });
  });
});

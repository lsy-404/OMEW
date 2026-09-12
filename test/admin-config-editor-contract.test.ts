import { describe, expect, it } from "vitest";
import modal from "../web/src/components/ServerAdminModal.vue?raw";
import mockApi from "../web/src/api/mock.ts?raw";

describe("instance policy editor contract", () => {
  it("keeps editing owner-only while administrators retain a read-only summary", () => {
    expect(modal).toMatch(/v-if="auth\.isServerOwner\.value"/);
    expect(modal).toMatch(/v-if="config && !auth\.isServerOwner\.value"/);
    expect(modal).toContain("只有服务器领主可以更新部署环境");
  });

  it("validates every line-list and submits the complete policy payload", () => {
    expect(modal).toMatch(/trustedServersError\(policyForm\.trustedServers\)/);
    expect(modal).toMatch(/domainListError\(policyForm\.federationPeers\)/);
    expect(modal).toMatch(/actorListError\(policyForm\.strongholdCreators\)/);
    expect(modal).toMatch(/api\.patchAdminConfig\(auth\.token\.value,\s*patch\)/);
    for (const field of [
      "allow_root",
      "root_requirements",
      "trusted_identity_servers",
      "federation_peers",
      "stronghold_creation_policy",
      "stronghold_creators",
      "allow_guest_browsing",
      "max_file_bytes",
      "user_storage_quota_bytes",
      "instance_mode",
      "root_stronghold",
      "sso_mode",
      "sso_issuer",
      "sso_client_id",
      "sso_provider_name",
    ]) expect(modal).toContain(`${field}:`);
  });

  it("communicates pending activation without exposing the application token", () => {
    expect(modal).toContain("令牌不会发送到浏览器");
    expect(modal).toContain("配置已提交到 Cloudflare");
    expect(modal).not.toContain("CF_API_TOKEN");
  });

  it("keeps mock mode on the same owner-only mutable contract", () => {
    expect(mockApi).toMatch(/async patchAdminConfig[\s\S]*?requireOwner\(token\)[\s\S]*?Object\.assign\(config, settings\)/);
  });
});

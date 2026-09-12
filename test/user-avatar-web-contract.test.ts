import { describe, expect, it } from "vitest";
import typesSource from "../web/src/api/types.ts?raw";
import clientSource from "../web/src/api/client.ts?raw";
import mockSource from "../web/src/api/mock.ts?raw";
import avatarBadgeSource from "../web/src/components/AvatarBadge.vue?raw";
import chatSource from "../web/src/components/ChatPane.vue?raw";
import messageSource from "../web/src/components/MessageBubble.vue?raw";
import personalSettingsSource from "../web/src/components/PersonalSettingsModal.vue?raw";
import personalUploaderSource from "../web/src/components/PersonalAvatarUploader.vue?raw";

describe("personal avatar web contract", () => {
  it("exposes upload and clear operations in both real and mock clients", () => {
    expect(typesSource).toContain("export interface AvatarUploadResult extends MediaUploadResult");
    expect(clientSource).toContain("uploadBlob<AvatarUploadResult>('/api/me/avatar'");
    expect(clientSource).toContain("request<{ avatar: null }>('/api/me/avatar', { method: 'DELETE'");
    expect(mockSource).toContain("async uploadAvatar(");
    expect(mockSource).toContain("async clearAvatar(");
  });

  it("passes projected avatar URLs into the shared avatar renderer", () => {
    expect(avatarBadgeSource).toContain("props.avatarUrl || (instanceConfig.value?.art_assets_enabled !== false ? defaultAvatarUrl(props.seed) : null)");
    expect(chatSource).toContain("avatarUrl: avatarUrl(item.actor)");
    expect(messageSource).toContain(":avatar-url=\"message.avatarUrl ?? undefined\"");
  });

  it("uploads a cropped avatar from personal settings and updates the active session", () => {
    expect(personalSettingsSource).toContain("<PersonalAvatarUploader");
    expect(personalSettingsSource).toContain("auth.updateUser({ avatar: nextAvatar })");
    expect(personalUploaderSource).toContain("api.uploadAvatar(props.token, blob)");
    expect(personalUploaderSource).toContain("api.clearAvatar(props.token)");
    expect(personalUploaderSource).toContain(':crop-ratio="1"');
    expect(personalUploaderSource).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
  });
});

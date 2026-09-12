import { describe, expect, it } from "vitest";
import { apiRequest, ensureMigrated } from "./helpers";

describe("OMEW authentication boundary", () => {
  it("does not expose the former StarDust session bridge", async () => {
    await ensureMigrated();
    const response = await apiRequest("/api/integration/star-dust/session", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-session" }),
    });
    expect(response.status).toBe(404);
  });
});

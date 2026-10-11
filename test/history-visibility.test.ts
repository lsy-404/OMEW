import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  connectRoom,
  itemCreateFrame,
  nextMessage,
  sessionToken,
} from "./helpers";

describe("private history on publication", () => {
  it("keeps prior private content hidden from anonymous and newly joined readers", async () => {
    const owner = "@historyowner:local";
    await sessionToken(owner);
    const stronghold = env.STRONGHOLD_DO.getByName("history-privacy");
    await stronghold.initConfig(
      "history-privacy",
      "Private history",
      "private",
      owner,
    );
    await stronghold.createRoom("chat", "channel", "Chat", ["text"], false);
    const { ws, stub } = await connectRoom("history-privacy/ch/chat", owner);
    ws.send(itemCreateFrame("private-item", "Keep this private"));
    await nextMessage(ws);
    await stronghold.updateConfig({ visibility: "public" });
    expect((await stub.getHistory(null, 50, null)).items).toEqual([]);
    await sessionToken("@laterreader:local");
    await stronghold.addMember("@laterreader:local");
    expect(
      (await stub.getHistory(null, 50, "@laterreader:local")).items,
    ).toEqual([]);
    expect((await stub.getHistory(null, 50, owner)).items).toHaveLength(1);
    const history = await stub.getFederationHistory(
      "history-privacy/ch/chat",
      0,
      null,
      10,
    );
    expect(JSON.stringify(history)).not.toContain("Keep this private");
    ws.close();
  });
});

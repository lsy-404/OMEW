import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../server/src/api";
import { ensureMigrated } from "./helpers";

beforeAll(ensureMigrated);

function inboxRequest(body: BodyInit | null, headers: HeadersInit = {}): Promise<Response> {
  return worker.fetch(
    new Request("http://local/inbox", {
      method: "POST",
      headers,
      body,
      duplex: body instanceof ReadableStream ? "half" : undefined,
    } as RequestInit),
    env
  );
}

describe("federation inbox body limits", () => {
  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const res = await inboxRequest("{}", { "Content-Length": String(64 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  it("rejects a streamed body over the single-envelope limit", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64 * 1024 + 1));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );

    const res = await inboxRequest(body);
    expect(res.status).toBe(413);
    expect(pulls).toBe(1);
  });
});

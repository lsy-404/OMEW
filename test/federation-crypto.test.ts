import { describe, expect, it } from "vitest";
import {
  signingInput,
  strictJson,
  verifyObject,
  type JsonObject,
} from "../server/src/federation-codec";
import vectors from "./vectors/m0-vectors.json";

describe("federation wire signatures", () => {
  it("verifies the independently published M0 signing vectors", async () => {
    let checked = 0;
    for (const vector of vectors.vectors)
      for (const entry of vector.cases) {
        const c = entry as unknown as {
          object?: JsonObject;
          domain_prefix?: string;
          public_key?: string;
          signature?: string;
          expected?: string;
          reject_reason?: string;
        };
        if (
          !c.object ||
          !c.domain_prefix ||
          !c.public_key ||
          !c.signature ||
          c.reject_reason
        )
          continue;
        expect(
          await verifyObject(
            c.domain_prefix,
            { ...c.object, sig: c.signature },
            c.public_key,
          ),
        ).toBe(true);
        checked++;
      }
    expect(checked).toBeGreaterThan(10);
  });
  it("rejects duplicate keys, nulls, unsafe integers and malformed unicode", () => {
    for (const raw of [
      '{"x":1,"x":2}',
      '{"a":{"x":1,"x":2}}',
      '{"x":null}',
      '{"x":9007199254740992}',
      '{"x":"\\ud800"}',
      "{} {}",
    ]) {
      expect(() => strictJson(raw)).toThrow();
    }
  });
  it("covers extension fields and the key id and separates signing domains", () => {
    const event = { v: 1, key_id: "one", x_extension: "signed" };
    expect(signingInput("openmew/event/v1", event)).not.toEqual(
      signingInput("openmew/event/v1", { ...event, x_extension: "changed" }),
    );
    expect(signingInput("openmew/event/v1", event)).not.toEqual(
      signingInput("openmew/event/v1", { ...event, key_id: "two" }),
    );
    expect(signingInput("openmew/event/v1", event)).not.toEqual(
      signingInput("openmew/assertion/v1", event),
    );
  });
});

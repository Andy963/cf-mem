import "./setup-crypto";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, isAuthorized } from "../src/api/http";

function makeRequest(headers: HeadersInit): Request {
  return new Request("https://example.com/api", { headers });
}

describe("constantTimeEqual", () => {
  it("compares equal and unequal tokens without depending on their length", async () => {
    await expect(constantTimeEqual("same-token", "same-token")).resolves.toBe(true);
    await expect(constantTimeEqual("short", "a much longer token")).resolves.toBe(false);
  });

  it("compares Unicode tokens by their encoded bytes", async () => {
    await expect(constantTimeEqual("api-token-🔐", "api-token-🔐")).resolves.toBe(true);
    await expect(constantTimeEqual("api-token-🔐", "api-token-🔑")).resolves.toBe(false);
  });
});

describe("isAuthorized", () => {
  it("accepts a matching Bearer token", async () => {
    await expect(isAuthorized(makeRequest({ Authorization: "Bearer api-token" }), "api-token")).resolves.toBe(true);
  });

  it("accepts a matching API key", async () => {
    await expect(isAuthorized(makeRequest({ "X-Api-Key": "api-token" }), "api-token")).resolves.toBe(true);
  });

  it("rejects an unequal-length token", async () => {
    await expect(isAuthorized(makeRequest({ Authorization: "Bearer wrong" }), "api-token")).resolves.toBe(false);
  });
});

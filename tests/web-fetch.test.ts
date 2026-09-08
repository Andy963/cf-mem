import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fetchPages } from "../src/web/fetch";

function makeEnv(overrides: Partial<Pick<Env, "TAVILY_API_TOKEN" | "TAVILY_BASE_URL">> = {}): Env {
  return { ...overrides } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPages", () => {
  it("fails closed without calling a user-provided URL when Tavily is unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPages(makeEnv(), ["https://example.com/article"])).resolves.toEqual([
      { url: "https://example.com/article", error: "tavily_relay_required" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not submit literal-IP or local targets to the relay", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPages(makeEnv({
      TAVILY_API_TOKEN: "relay-token",
      TAVILY_BASE_URL: "https://relay.example.com",
    }), ["http://127.0.0.1/", "http://localhost/admin"])).resolves.toEqual([
      { url: "http://127.0.0.1/", error: "Private, local, or non-public URLs are not allowed" },
      { url: "http://localhost/admin", error: "Private, local, or non-public URLs are not allowed" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to a user-provided URL when Tavily omits a result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPages(makeEnv({
      TAVILY_API_TOKEN: "relay-token",
      TAVILY_BASE_URL: "https://relay.example.com",
    }), ["https://example.com/article"])).resolves.toEqual([
      { url: "https://example.com/article", error: "url_fetch_unavailable" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://relay.example.com/extract");
  });

  it("returns an unavailable failure when the relay request fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("relay unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPages(makeEnv({
      TAVILY_API_TOKEN: "relay-token",
      TAVILY_BASE_URL: "https://relay.example.com",
    }), ["https://example.com/article"])).resolves.toEqual([
      { url: "https://example.com/article", error: "url_fetch_unavailable" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns only relay results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        results: [{
          url: "https://example.com/article",
          title: "Example article",
          raw_content: "Article text",
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPages(makeEnv({
      TAVILY_API_TOKEN: "relay-token",
      TAVILY_BASE_URL: "https://relay.example.com",
    }), ["https://example.com/article"])).resolves.toMatchObject([
      {
        url: "https://example.com/article",
        final_url: "https://example.com/article",
        title: "Example article",
        text: "Article text",
        provider: "tavily",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

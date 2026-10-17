import { afterEach, describe, expect, it, vi } from "vitest";
import { expiredNextStart, hasExpiredAccount, requireExpiredCookie } from "@/lib/expired";
import { repositoryCheck, resolveFilterChecks } from "@/lib/filter-checker";

afterEach(() => vi.unstubAllGlobals());

describe("Account-only full discovery", () => {
  it("rejects scraping without an account cookie", () => {
    expect(() => requireExpiredCookie("")).toThrow("Connect your ExpiredDomains account");
  });
  it("rejects a guest page even when it contains domains or the word logout", () => {
    expect(hasExpiredAccount('<a href="/login/">Login</a><p>logout</p>')).toBe(false);
    expect(hasExpiredAccount('<a href="/logout/">Logout</a>')).toBe(true);
  });
  it("continues past the old 400-page cap", () => {
    expect(expiredNextStart('<a href="?start=10025&amp;o=domain">Next Page</a>', 10000)).toBe(10025);
    expect(expiredNextStart('<a href="?start=9975">Previous</a>', 10000)).toBeNull();
  });
});

describe("Repository-first filters with LLLogan fallback", () => {
  it("uses LLLogan only for failed checks and keeps successful primary results", async () => {
    const fallback = vi.fn(async () => [{ site: "failed.xyz", filter: "senso", status: "blocked" as const, category: "Games" }]);
    const results = await resolveFilterChecks(["good.xyz", "failed.xyz"], ["senso"], async (site, filter) => site === "good.xyz" ? { site, filter, status: "unblocked", category: "Education" } : null, fallback);
    expect(fallback).toHaveBeenCalledWith(["failed.xyz"], ["senso"]);
    expect(results.find((r) => r.site === "good.xyz")?.status).toBe("unblocked");
    expect(results.find((r) => r.site === "failed.xyz")?.source).toBe("LLLogan");
  });
  it("returns an error for every failed pair when both providers fail", async () => {
    const results = await resolveFilterChecks(["example.xyz"], ["senso", "securly", "lightspeed"], async () => null, async () => { throw new Error("offline"); });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "error")).toBe(true);
  });
  it("does not treat malformed repository responses as unblocked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(["unknown-category"]))));
    expect(await repositoryCheck("example.xyz", "senso")).toBeNull();
  });
});
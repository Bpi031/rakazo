import { describe, expect, it } from "vitest";
import { isAllowedWebOrigin, parseAdditionalWebOrigins } from "./web-origins.js";

describe("operator-managed web origins", () => {
  it("defaults to no additional origins and deduplicates an exact bounded list", () => {
    expect(parseAdditionalWebOrigins(undefined)).toEqual([]);
    expect(parseAdditionalWebOrigins(" ")).toEqual([]);
    expect(
      parseAdditionalWebOrigins(
        " http://192.0.2.10:5173, https://team.example,https://team.example ",
      ),
    ).toEqual(["http://192.0.2.10:5173", "https://team.example"]);
  });
  it.each([
    "*",
    "null",
    "https://*.example",
    "http://user:password@team.example",
    "https://team.example/",
    "https://team.example/path",
    "https://team.example?x=1",
    "https://team.example#x",
    "file:///tmp",
    "rakazo://sign-in",
    "//team.example",
    "https://team.example,",
    "https://team.example,,https://other.example",
    "https://team.example".repeat(300),
    Array(9).fill("https://team.example").join(","),
  ])("rejects invalid or unbounded additional origin %s", (value) => {
    expect(() => parseAdditionalWebOrigins(value)).toThrow("WEB_ADDITIONAL_ORIGINS");
  });
  it("accepts only the primary and explicitly configured additional web origins", () => {
    const env = {
      webOrigin: "http://192.0.2.10:5173",
      additionalWebOrigins: ["http://192.0.2.11:5173"],
    };
    for (const origin of [env.webOrigin, env.additionalWebOrigins[0]])
      expect(isAllowedWebOrigin(origin, env)).toBe(true);
    for (const origin of [
      undefined,
      "",
      "null",
      "http://192.0.2.12:5173",
      "http://192.0.2.11:5174",
      "https://192.0.2.11:5173",
      "http://192.0.2.11:5173.evil.test",
      "http://192.0.2.11:5173/path",
    ])
      expect(isAllowedWebOrigin(origin, env)).toBe(false);
    expect(isAllowedWebOrigin(env.additionalWebOrigins[0], { webOrigin: env.webOrigin })).toBe(
      false,
    );
  });
});

import { expect } from "chai";
import { redact, redactJson } from "../../src/lib/redact";

describe("redact", () => {
  it("masks default sensitive keys at top level", () => {
    const result = redact({
      user: "sven",
      token: "abc123",
      cloudApiToken: "xyz",
    });
    expect(result).to.deep.equal({
      user: "sven",
      token: "***",
      cloudApiToken: "***",
    });
  });

  it("masks sensitive keys at any depth", () => {
    const result = redact({
      level1: {
        level2: {
          password: "secret",
          name: "ok",
        },
      },
    });
    expect(result).to.deep.equal({
      level1: {
        level2: {
          password: "***",
          name: "ok",
        },
      },
    });
  });

  it("walks arrays of objects", () => {
    const result = redact([
      { user: "a", token: "1" },
      { user: "b", token: "2" },
    ]);
    expect(result).to.deep.equal([
      { user: "a", token: "***" },
      { user: "b", token: "***" },
    ]);
  });

  it("does not mutate the input", () => {
    const input = { token: "abc", user: "sven" };
    redact(input);
    expect(input.token).to.equal("abc");
  });

  it("leaves primitives untouched", () => {
    expect(redact("hello")).to.equal("hello");
    expect(redact(42)).to.equal(42);
    expect(redact(null)).to.equal(null);
    expect(redact(undefined)).to.equal(undefined);
  });

  it("preserves empty-string and null sensitive values without replacing them", () => {
    const result = redact({ token: "", refresh_token: null });
    // We mask only non-empty strings; empty/null stays as-is to avoid hiding
    // the absence of credentials, which can be useful in logs.
    expect(result).to.deep.equal({ token: "", refresh_token: null });
  });

  it("respects a custom sensitive-keys list", () => {
    const result = redact({ customField: "v", token: "t" }, ["customField"]);
    expect(result).to.deep.equal({ customField: "***", token: "t" });
  });

  it("redactJson returns redacted JSON string", () => {
    const json = redactJson({ user: "sven", token: "xyz" });
    expect(JSON.parse(json)).to.deep.equal({ user: "sven", token: "***" });
  });
});

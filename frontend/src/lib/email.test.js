import { describe, expect, it } from "vitest";
import { checkEmailForm, isEmail, splitAddresses } from "./email.js";

const ok = { to: "bob@example.com", cc: "", subject: "Fares", formats: ["pdf"] };

describe("email form", () => {
  it("splits addresses on commas, semicolons and spaces", () => {
    expect(splitAddresses(" a@x.com, b@y.org;c@z.io  d@w.in ")).toEqual(["a@x.com", "b@y.org", "c@z.io", "d@w.in"]);
    expect(splitAddresses("")).toEqual([]);
  });

  it("knows an address when it sees one", () => {
    expect(isEmail("ada@example.com")).toBe(true);
    for (const bad of ["ada", "ada@", "@x.com", "ada@x", "a b@x.com", "ada@x.c"]) expect(isEmail(bad)).toBe(false);
  });

  it("accepts a good form", () => {
    expect(checkEmailForm(ok)).toEqual({});
  });

  it("names every problem", () => {
    expect(checkEmailForm({ ...ok, to: "" }).to).toMatch(/at least one/);
    expect(checkEmailForm({ ...ok, to: "bob@example.com, nope" }).to).toBe("Not an email address: nope");
    expect(checkEmailForm({ ...ok, cc: "x@" }).cc).toBe("Not an email address: x@");
    expect(checkEmailForm({ ...ok, subject: "  " }).subject).toMatch(/subject/);
    expect(checkEmailForm({ ...ok, formats: [] }).formats).toMatch(/at least one format/);
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(",");
    expect(checkEmailForm({ ...ok, to: many }).to).toMatch(/At most 10/);
    // The same address twice counts once.
    expect(checkEmailForm({ ...ok, to: "a@x.com", cc: "A@x.com" })).toEqual({});
  });
});

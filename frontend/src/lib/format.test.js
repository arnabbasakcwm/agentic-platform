import { describe, expect, it } from "vitest";
import { currencyOf, formatDuration, formatValue, humanizeKey } from "./format.js";

describe("formatValue", () => {
  it("formats money in the currency its key names, without converting", () => {
    expect(currencyOf("cheapest_one_way_price_inr")).toBe("INR");
    expect(formatValue("cheapest_one_way_price_inr", 7004)).toBe("₹7,004");
    expect(formatValue("fare_inr", 1234567)).toBe("₹12,34,567"); // Indian digit grouping
    expect(formatValue("cheapest_round_trip_price_usd", 118)).toBe("$118");
    expect(formatValue("fare_usd", 118.5)).toBe("$118.50");
  });

  it("formats plain numbers, booleans and empty values", () => {
    expect(formatValue("passengers", 2500)).toBe("2,500");
    expect(formatValue("direct", true)).toBe("Yes");
    expect(formatValue("note", null)).toBe("—");
  });

  it("turns keys into labels that name the currency", () => {
    expect(humanizeKey("cheapest_round_trip_price_usd")).toBe("Cheapest round trip price (USD)");
    expect(humanizeKey("travelMonth")).toBe("Travel month");
  });

  it("formats durations", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4_200)).toBe("4.2 s");
    expect(formatDuration(12_300)).toBe("12 s");
    expect(formatDuration(84_000)).toBe("1m 24s");
  });
});

import { describe, expect, it } from "vitest";
import { SourceBreakers } from "@/lib/v2/breaker";
import { HostPacer } from "@/lib/v2/pacer";

describe("v2 source breakers", () => {
  const make = () => {
    let t = 1_000_000;
    const b = new SourceBreakers(3, 60_000, () => t);
    return { b, advance: (ms: number) => (t += ms) };
  };

  it("opens after N consecutive failures and fails fast while open", () => {
    const { b } = make();
    b.failure("a");
    b.failure("a");
    expect(b.state("a")).toBe("closed");
    b.failure("a");
    expect(b.state("a")).toBe("open");
    expect(b.tryAcquire("a")).toBe(false);
  });

  it("a success resets the consecutive count", () => {
    const { b } = make();
    b.failure("a");
    b.failure("a");
    b.success("a");
    b.failure("a");
    b.failure("a");
    expect(b.state("a")).toBe("closed");
  });

  it("goes half-open after the cooldown, allows exactly one trial, closes on success", () => {
    const { b, advance } = make();
    for (let i = 0; i < 3; i++) b.failure("a");
    advance(60_000);
    expect(b.state("a")).toBe("half_open");
    expect(b.tryAcquire("a")).toBe(true);
    expect(b.tryAcquire("a")).toBe(false);
    b.success("a");
    expect(b.state("a")).toBe("closed");
    expect(b.tryAcquire("a")).toBe(true);
  });

  it("re-opens when the half-open trial fails, with a longer cooldown", () => {
    const { b, advance } = make();
    for (let i = 0; i < 3; i++) b.failure("a");
    advance(60_000);
    expect(b.tryAcquire("a")).toBe(true);
    b.failure("a");
    expect(b.state("a")).toBe("open");
    advance(60_000);
    expect(b.state("a")).toBe("open");
    advance(60_000);
    expect(b.state("a")).toBe("half_open");
  });

  it("neutral outcomes release the trial slot without changing state", () => {
    const { b, advance } = make();
    for (let i = 0; i < 3; i++) b.failure("a");
    advance(60_000);
    expect(b.tryAcquire("a")).toBe(true);
    b.neutral("a");
    expect(b.state("a")).toBe("half_open");
    expect(b.tryAcquire("a")).toBe(true);
  });

  it("orders closed sources first, half-open last and drops open ones (stable within groups)", () => {
    const { b, advance } = make();
    for (let i = 0; i < 3; i++) b.failure("half");
    advance(60_000);
    for (let i = 0; i < 3; i++) b.failure("open");
    expect(b.order(["half", "x", "open", "y"], (s) => s)).toEqual(["x", "y", "half"]);
  });
});

describe("v2 host pacer (1 request / second / host)", () => {
  it("spaces requests to one host by the interval and keeps hosts independent", () => {
    let t = 0;
    const p = new HostPacer(1_000, () => t);
    expect(p.reserve("a.example", 10_000)).toBe(0);
    expect(p.reserve("a.example", 10_000)).toBe(1_000);
    expect(p.reserve("A.EXAMPLE", 10_000)).toBe(2_000);
    expect(p.reserve("b.example", 10_000)).toBe(0);
    t = 5_000;
    expect(p.reserve("a.example", 10_000)).toBe(0);
  });

  it("refuses (does not queue) when the next slot is beyond maxWait", () => {
    const p = new HostPacer(1_000, () => 0);
    expect(p.reserve("h", 1_500)).toBe(0);
    expect(p.reserve("h", 1_500)).toBe(1_000);
    expect(p.reserve("h", 1_500)).toBeNull();
    // A refused call does not consume a slot.
    expect(p.reserve("h", 2_500)).toBe(2_000);
  });

  it("wait() sleeps for the reserved delay", async () => {
    const sleeps: number[] = [];
    const p = new HostPacer(1_000, () => 0, async (ms) => void sleeps.push(ms));
    expect(await p.wait("h", 5_000)).toBe(true);
    expect(await p.wait("h", 5_000)).toBe(true);
    expect(sleeps).toEqual([1_000]);
  });

  it("bounds the number of tracked hosts", () => {
    const p = new HostPacer(1_000, () => 0, async () => {}, 3);
    for (const h of ["a", "b", "c", "d", "e"]) p.reserve(h, 0);
    expect((p as unknown as { next: Map<string, number> }).next.size).toBeLessThanOrEqual(3);
  });
});

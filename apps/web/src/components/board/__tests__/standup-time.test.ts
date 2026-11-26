import { describe, expect, it } from "vitest";
import { formatClock, formatWorkTime, localDateKey, previousWorkingDayStart } from "../standup-time";

// Local-time constructors so these hold in any TZ the test runs in.
const localMidnight = (y: number, mo: number, d: number) => new Date(y, mo, d, 0, 0, 0, 0).getTime();

describe("previousWorkingDayStart", () => {
  it("Monday goes back to Friday 00:00 local", () => {
    // 2026-11-16 is a Monday
    expect(previousWorkingDayStart(new Date(2026, 10, 16, 9, 30)).getTime()).toBe(localMidnight(2026, 10, 13));
  });

  it("Saturday goes back to Friday", () => {
    // 2026-11-21 is a Saturday
    expect(previousWorkingDayStart(new Date(2026, 10, 21, 12, 0)).getTime()).toBe(localMidnight(2026, 10, 20));
  });

  it("Sunday goes back to Friday", () => {
    // 2026-11-22 is a Sunday
    expect(previousWorkingDayStart(new Date(2026, 10, 22, 8, 0)).getTime()).toBe(localMidnight(2026, 10, 20));
  });

  it("Wednesday goes back to Tuesday", () => {
    // 2026-11-18 is a Wednesday
    expect(previousWorkingDayStart(new Date(2026, 10, 18, 23, 59)).getTime()).toBe(localMidnight(2026, 10, 17));
  });

  it("Thursday goes back to Wednesday", () => {
    // 2026-11-19 is a Thursday
    expect(previousWorkingDayStart(new Date(2026, 10, 19, 10, 0)).getTime()).toBe(localMidnight(2026, 10, 18));
  });
});

describe("localDateKey", () => {
  it("formats the local calendar date with zero padding", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 10, 19, 0, 1))).toBe("2026-11-19");
  });
});

describe("formatClock", () => {
  it("formats milliseconds as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59_999)).toBe("0:59");
    expect(formatClock(125_000)).toBe("2:05");
    expect(formatClock(15 * 60 * 1000)).toBe("15:00");
  });

  it("never goes negative", () => {
    expect(formatClock(-5_000)).toBe("0:00");
  });
});

describe("formatWorkTime", () => {
  it("shows hours and minutes, dropping a zero part", () => {
    expect(formatWorkTime(5400)).toBe("1h 30m");
    expect(formatWorkTime(7200)).toBe("2h");
    expect(formatWorkTime(45 * 60)).toBe("45m");
  });

  it("rounds to whole minutes and never shows less than 1m", () => {
    expect(formatWorkTime(10)).toBe("1m");
    expect(formatWorkTime(89)).toBe("1m");
    expect(formatWorkTime(91)).toBe("2m");
  });
});

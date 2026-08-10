import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginBrowserAutomationRequest,
  browserAutomationCountsAsActivity,
  useBrowserAutomationActivityStore,
} from "./browserAutomationActivityStore";

beforeEach(() => {
  useBrowserAutomationActivityStore.setState({ activeByThreadKey: {} });
});

const activeKeys = () => useBrowserAutomationActivityStore.getState().activeByThreadKey;

describe("browserAutomationCountsAsActivity", () => {
  it("ignores status probes, which agents run before a browser exists", () => {
    expect(browserAutomationCountsAsActivity("status")).toBe(false);
  });

  it("counts operations that actually drive the browser", () => {
    for (const operation of ["open", "navigate", "click", "type", "evaluate"] as const) {
      expect(browserAutomationCountsAsActivity(operation)).toBe(true);
    }
  });
});

describe("browserAutomationActivityStore", () => {
  it("tracks threads independently", () => {
    beginBrowserAutomationRequest("env_a:thread_1");
    beginBrowserAutomationRequest("env_a:thread_2");

    expect(activeKeys()).toEqual({ "env_a:thread_1": 1, "env_a:thread_2": 1 });
  });

  it("keeps a thread active until the last overlapping request settles", () => {
    vi.useFakeTimers();
    try {
      const first = beginBrowserAutomationRequest("env_a:thread_1", { lingerMs: 0 });
      const second = beginBrowserAutomationRequest("env_a:thread_1", { lingerMs: 0 });
      expect(activeKeys()["env_a:thread_1"]).toBe(2);

      first();
      vi.advanceTimersByTime(0);
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      second();
      vi.advanceTimersByTime(0);
      expect(activeKeys()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers the release so brief requests stay visible", () => {
    vi.useFakeTimers();
    try {
      const settle = beginBrowserAutomationRequest("env_a:thread_1", { lingerMs: 900 });
      settle();

      // Still lit immediately after the request finished.
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      vi.advanceTimersByTime(899);
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      vi.advanceTimersByTime(1);
      expect(activeKeys()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a repeated settle so an error path cannot double-release", () => {
    vi.useFakeTimers();
    try {
      const outer = beginBrowserAutomationRequest("env_a:thread_1", { lingerMs: 900 });
      const inner = beginBrowserAutomationRequest("env_a:thread_1", { lingerMs: 900 });

      outer();
      outer();
      vi.advanceTimersByTime(900);

      // The second request is untouched by the duplicate settle.
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      inner();
      vi.advanceTimersByTime(900);
      expect(activeKeys()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a request that never settles, so the globe cannot pulse forever", () => {
    vi.useFakeTimers();
    try {
      // No settle call: the handler is stranded on a guest that went away.
      beginBrowserAutomationRequest("env_a:thread_1", { ceilingMs: 5_000 });

      vi.advanceTimersByTime(4_999);
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      vi.advanceTimersByTime(1);
      expect(activeKeys()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("strands only the request that hung, not the ones still running", () => {
    vi.useFakeTimers();
    try {
      beginBrowserAutomationRequest("env_a:thread_1", { ceilingMs: 5_000 });
      const live = beginBrowserAutomationRequest("env_a:thread_1", { ceilingMs: 30_000 });

      vi.advanceTimersByTime(5_000);
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      live();
      vi.advanceTimersByTime(900);
      expect(activeKeys()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms the watchdog on settle so it cannot double-release", () => {
    vi.useFakeTimers();
    try {
      const settle = beginBrowserAutomationRequest("env_a:thread_1", {
        lingerMs: 900,
        ceilingMs: 5_000,
      });
      const second = beginBrowserAutomationRequest("env_a:thread_1", { ceilingMs: 30_000 });

      settle();
      vi.advanceTimersByTime(900);
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      // The disarmed watchdog would otherwise fire here and take the second
      // request's count with it.
      vi.advanceTimersByTime(5_000);
      expect(activeKeys()["env_a:thread_1"]).toBe(1);

      second();
      vi.advanceTimersByTime(900);
      expect(activeKeys()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("never drops below zero when a release arrives with nothing in flight", () => {
    useBrowserAutomationActivityStore.getState().release("env_a:thread_1");

    expect(activeKeys()).toEqual({});
  });
});

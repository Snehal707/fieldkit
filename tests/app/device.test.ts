import { describe, expect, it } from "vitest";
import { browserOf, deviceLabel, otherDeviceRecords, platformOf } from "../../app/src/device";

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
  ipadOS: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0",
};

describe("device names", () => {
  it("distinguishes Safari, the Home Screen app and other devices", () => {
    expect(deviceLabel(UA.iphoneSafari, false)).toBe("iPhone · Safari");
    expect(deviceLabel(UA.iphoneSafari, true)).toBe("iPhone · Home Screen app");
    expect(deviceLabel(UA.iphoneChrome, false)).toBe("iPhone · Chrome");
    expect(deviceLabel(UA.android, false)).toBe("Android phone · Chrome");
    expect(deviceLabel(UA.windowsEdge, false)).toBe("Windows · Edge");
    expect(platformOf(UA.ipadOS, 5)).toBe("iPad");          // iPadOS identifies as a Mac with touch
    expect(platformOf(UA.ipadOS, 0)).toBe("Mac");
    expect(browserOf(UA.ipadOS)).toBe("Safari");
  });
});

describe("records from other devices", () => {
  it("excludes records already on this device and de-duplicates", () => {
    const server = [
      { id: "rec_a", received_at: 10 }, { id: "rec_b", received_at: 30 }, { id: "rec_c", received_at: 20 }, { id: "rec_b", received_at: 30 },
    ];
    expect(otherDeviceRecords(server, ["rec_a"]).map((r) => r.id)).toEqual(["rec_b", "rec_c"]);
    expect(otherDeviceRecords(server, ["rec_a", "rec_b", "rec_c"])).toEqual([]);
  });
});

describe("one Saved Records list for the whole account", () => {
  it("one entry per record, this device's copy wins, availability is explicit, no ids shown as sources", async () => {
    const { unifiedRecords } = await import("../../app/src/device");
    const local = [
      { id: "rec_1", workflow_title: "Inspection", completed_at: "2026-11-09T10:00:00Z", sync_status: "synced", analysis_status: "completed" },
      { id: "rec_2", workflow_title: "Inspection", completed_at: "2026-11-09T11:00:00Z", sync_status: "pending", analysis_status: "not_requested" },
    ];
    const server = [
      { id: "rec_1", workflow_id: "w", workflow_title: "Inspection", completed_at: "2026-11-09T10:00:00Z", device_id: "dev_me", analysis_status: "completed" },
      { id: "rec_3", workflow_id: "w", workflow_title: "Survey", completed_at: "2026-11-09T09:00:00Z", device_id: "dev_safari", analysis_status: "completed", report_id: "rep_3" },
      { id: "rec_4", workflow_id: "w", workflow_title: "Survey", completed_at: "2026-11-09T08:00:00Z", device_id: "dev_unknown", analysis_status: "pending" },
    ];
    const copies = [
      { id: "rec_3", workflow_title: "Survey", completed_at: "2026-11-09T09:00:00Z", device_label: "iPhone · Safari", analysis_status: "completed", report: {} },
      { id: "rec_5", workflow_title: "Old", completed_at: "2026-11-01T09:00:00Z", device_label: "Windows · Chrome", analysis_status: "completed", report: null },
    ];
    const list = unifiedRecords(local, server, copies, new Map([["dev_safari", "iPhone · Safari"]]), "dev_me");
    expect(list.map((r) => r.id)).toEqual(["rec_2", "rec_1", "rec_3", "rec_4", "rec_5"]);   // newest first, no duplicates
    const by = Object.fromEntries(list.map((r) => [r.id, r]));
    expect(by.rec_1).toMatchObject({ availability: "on-device", source: "This device", href: "#/results/rec_1" });
    expect(by.rec_2).toMatchObject({ availability: "waiting", syncNote: "pending" });
    expect(by.rec_3).toMatchObject({ availability: "kept-offline", source: "iPhone · Safari", href: "#/remote/rec_3", hasReport: true });
    expect(by.rec_4).toMatchObject({ availability: "needs-internet", source: "Another device" });   // never a raw id
    expect(by.rec_5).toMatchObject({ availability: "kept-offline", source: "Windows · Chrome" });
    expect(list.some((r) => /dev_/.test(r.source))).toBe(false);
  });
});

describe("load problems are reported clearly", () => {
  it("never calls an HTTP error 'offline'; offline only when the device is offline", async () => {
    const { describeLoadProblem } = await import("../../app/src/device");
    const { AuthRequired, HttpError, Offline } = await import("../../app/src/api");
    expect(describeLoadProblem(new Offline(), false).kind).toBe("offline");
    expect(describeLoadProblem(new Offline(), true).kind).toBe("unreachable");          // online but request failed
    expect(describeLoadProblem(new AuthRequired(true), true).kind).toBe("signed-out");
    const outdated = describeLoadProblem(new HttpError(404, { detail: "Not Found" }, true), true, "0.1.9", "0.2.1");
    expect(outdated.kind).toBe("server-outdated");
    expect(outdated.message).toContain("0.1.9");
    expect(outdated.message).toContain("Restart the Hermes dashboard");
    expect(describeLoadProblem(new HttpError(404, null), true).kind).toBe("server-outdated");
    const err = describeLoadProblem(new HttpError(500, "boom"), true);
    expect(err.kind).toBe("server-error");
    expect(err.message).toContain("HTTP 500");
    for (const e of [new HttpError(404, null), new HttpError(500, ""), new HttpError(503, ""), new AuthRequired()]) {
      expect(describeLoadProblem(e, true).message.toLowerCase()).not.toContain("offline");
    }
  });
});

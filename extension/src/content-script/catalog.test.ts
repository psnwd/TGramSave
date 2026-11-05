// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({
  default: {
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    runtime: { sendMessage: vi.fn(), getURL: vi.fn() },
  },
}));

import { extractAllMediaFromMessage } from "./catalog";

function mount(inner: string): Element {
  document.body.innerHTML = `<div class="MessageList">${inner}</div>`;
  return document.querySelector(".Message") as Element;
}

const item = (src: string, extra = ""): string => `<div class="album-item"><img src="${src}" ${extra} /></div>`;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("extractAllMediaFromMessage", () => {
  it("extracts every item in an album with stable ids", () => {
    const wrapper = mount(
      `<div class="Message" data-mid="42">
        <div class="album-item"><video src="blob:https://web.telegram.org/v"></video></div>
        ${item("blob:https://web.telegram.org/i1")}
        ${item("blob:https://web.telegram.org/i2")}
      </div>`,
    );

    const found = extractAllMediaFromMessage(wrapper, false, false);
    expect(found.map((entry) => entry.item.videoId)).toEqual(["42_0", "42_1", "42_2"]);
    expect(found.map((entry) => entry.item.kind)).toEqual(["video", "image", "image"]);
  });

  it("does not treat avatars as media", () => {
    const wrapper = mount(`<div class="Message" data-mid="7"><img class="Avatar__media" src="blob:a" /></div>`);
    expect(extractAllMediaFromMessage(wrapper, false, false)).toHaveLength(0);
  });

  it("ignores data: placeholder images", () => {
    const wrapper = mount(`<div class="Message" data-mid="8"><img src="data:image/svg+xml,%3Csvg%3E" /></div>`);
    expect(extractAllMediaFromMessage(wrapper, false, false)).toHaveLength(0);
  });

  it("gates promotional previews behind allowPreviews", () => {
    const wrapper = mount(
      `<div class="Message" data-mid="9"><div class="WebPage with-quick-button"><img src="blob:p" /></div></div>`,
    );
    expect(extractAllMediaFromMessage(wrapper, false, false, false)).toHaveLength(0);
    expect(extractAllMediaFromMessage(wrapper, false, false, true)).toHaveLength(1);
  });

  it("skips WebM/stickers by default", () => {
    const wrapper = mount(
      `<div class="Message" data-mid="10"><div class="album-item"><video src="blob:https://web.telegram.org/x.webm"></video></div></div>`,
    );
    expect(extractAllMediaFromMessage(wrapper, false, false)).toHaveLength(0);
    expect(extractAllMediaFromMessage(wrapper, true, false)).toHaveLength(1);
  });
});

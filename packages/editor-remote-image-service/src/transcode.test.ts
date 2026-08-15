import { describe, expect, it, vi } from "vitest";
import { transcodeRemoteImage } from "./transcode";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("远端图片转存", () => {
  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.8", "::1"])(
    "拒绝私有或本地地址 %s",
    async (address) => {
      await expect(
        transcodeRemoteImage("https://images.example/a.png", {
          resolve: async () => [address],
          fetch: async () => response(200, png, "image/png"),
          store: async () => ({ url: "https://assets.example/a.png" }),
        }),
      ).rejects.toMatchObject({ code: "private-address" });
    },
  );

  it("逐跳复检重定向目标并仅保存嗅探通过的图片", async () => {
    let calls = 0;
    const store = vi.fn(async () => ({ url: "https://assets.example/a.png" }));

    await expect(
      transcodeRemoteImage("https://images.example/a.png", {
        resolve: async (host) => (host === "images.example" ? ["203.0.113.2"] : ["127.0.0.1"]),
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? response(302, new Uint8Array(), undefined, "https://internal.example/internal.png")
            : response(200, png, "image/png");
        },
        store,
      }),
    ).rejects.toMatchObject({ code: "private-address" });
    expect(store).not.toHaveBeenCalled();
  });

  it("拒绝伪装成图片的响应", async () => {
    await expect(
      transcodeRemoteImage("https://images.example/a.png", {
        resolve: async () => ["203.0.113.2"],
        fetch: async () => response(200, new TextEncoder().encode("not an image"), "image/png"),
        store: async () => ({ url: "https://assets.example/a.png" }),
      }),
    ).rejects.toMatchObject({ code: "invalid-image" });
  });
});

function response(status: number, body: Uint8Array, contentType?: string, location?: string) {
  return {
    status,
    headers: {
      get(name: string) {
        if (name === "content-type") return contentType ?? null;
        if (name === "location") return location ?? null;
        return null;
      },
    },
    body: (async function* () {
      yield body;
    })(),
  };
}

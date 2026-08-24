import { describe, it, expect, beforeEach } from "vitest";
import { ED3DM } from "../src/index";

const OVERVIEW = {
  cells: [
    {
      id: "sol",
      cx: 0,
      cy: 0,
      cz: 0,
      size: 80,
      count: 3,
      tile: "tiles/sol.json",
    },
    {
      id: "core",
      cx: 25,
      cy: -21,
      cz: 25900,
      size: 1280,
      count: 40,
      tile: "tiles/core.json",
    },
  ],
};

describe("ED3DM first paint", () => {
  const fetched: string[] = [];

  beforeEach(() => {
    fetched.length = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes("overview.json")) {
        return new Response(JSON.stringify(OVERVIEW), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  });

  it("loads only the density overview and fetches no tiles", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    await ED3DM.create({
      container,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });

    expect(fetched).toEqual(["/catalog/overview.json"]);
  });
});

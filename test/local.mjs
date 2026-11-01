// Exercises the Worker's fetch handler directly, against the live cdnjs API.
// Node 22 provides fetch/Request/Response, so no wrangler needed.
import worker from "../src/index.js";

let fails = 0;
const call = async (body) => {
  const res = await worker.fetch(new Request("https://x/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: res.status === 202 ? null : await res.json() };
};
const tool = (name, args = {}) =>
  call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

console.log("initialize");
{
  const r = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  check("returns serverInfo", r.json?.result?.serverInfo?.name === "cdnjs");
  check("echoes supported protocol", r.json?.result?.protocolVersion === "2025-06-18");
  check("advertises tools capability", !!r.json?.result?.capabilities?.tools);
}

console.log("notifications get 202, no body");
{
  const r = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("202 accepted", r.status === 202);
}

console.log("tools/list");
{
  const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = (r.json?.result?.tools || []).map((t) => t.name);
  check("all four tools", names.length === 4, names.join(","));
  check("each has an inputSchema", (r.json?.result?.tools || []).every((t) => t.inputSchema?.type === "object"));
}

console.log("GOTCHA 1 — case-insensitive name resolution");
{
  const r = await tool("cdnjs_library", { name: "chart.js" });   // 404s on raw API
  const t = r.json?.result?.content?.[0]?.text || "";
  check("resolves lowercase to Chart.js", t.includes("Chart.js"), t.slice(0, 90));
  check("says it corrected the name", t.includes("not the canonical name"));
  check("gives a pinned URL", /cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/\d/.test(t));
  check("gives an SRI hash", t.includes('integrity="sha'));
}

console.log("GOTCHA 2 — versions[0] can be a prerelease");
{
  // vue's raw array leads with 3.6.0-rc.14 while its current release is older.
  const r = await tool("cdnjs_versions", { name: "vue", limit: 5 });
  const t = r.json?.result?.content?.[0]?.text || "";
  const listed = t.split("\n").filter((l) => /^\d/.test(l));
  check("no prerelease in default output", !listed.some((l) => /-(rc|alpha|beta|canary)/i.test(l)),
    listed.slice(0, 3).join(" | "));
  check("says prereleases were hidden", t.includes("prerelease(s) hidden"));
  check("marks the current stable", t.includes("← current"));

  const withPre = await tool("cdnjs_versions", { name: "vue", limit: 5, include_prereleases: true });
  const tp = withPre.json?.result?.content?.[0]?.text || "";
  check("include_prereleases brings them back", /-(rc|alpha|beta|canary)/i.test(tp));
}

console.log("GOTCHA 3 — legacy tags must not outrank the current version");
{
  // three.js carries 217 non-semver tags (r134, 110) beside modern 0.187.0
  // releases. A naive numeric sort puts bare "110" above "0.187.0" and buries
  // the current version under all of them. The assertion is self-anchoring:
  // it reads the current version out of the same response, so it cannot rot.
  const r = await tool("cdnjs_versions", { name: "three.js", limit: 10 });
  const t = r.json?.result?.content?.[0]?.text || "";
  const current = (t.match(/current stable is (.+)\.$/m) || [])[1];
  const ROW = /^[0-9r][\w.\-+]*(\s{2}←\s*current)?\s*$/i;
  const rows = t.split("\n").filter((l) => ROW.test(l)).map((l) => l.split("  ")[0].trim());
  check("reports a current stable", !!current, t.slice(0, 80));
  check("first listed version IS the current stable", rows[0] === current,
    `first=${rows[0]} current=${current}`);
  check("first row carries the marker", /←\s*current/.test(t.split("\n").find((l) => l.startsWith(rows[0])) || ""));
  const isModern = (v) => String(v).replace(/^r/i, "").split("-")[0].split(".").length >= 3;
  check("second entry is modern too, not a legacy tag", isModern(rows[1]),
    `rows[0..2]=${rows.slice(0, 3).join(" | ")}`);

  // And the tier rule itself: modern semver before legacy, across the board.
  const full = await tool("cdnjs_versions", { name: "three.js", limit: 100 });
  const ft = full.json?.result?.content?.[0]?.text || "";
  const fr = ft.split("\n").filter((l) => ROW.test(l)).map((l) => l.split("  ")[0].trim());
  const tier = (v) => (v.replace(/^r/i, "").split("-")[0].split(".").length >= 3 ? 1 : 0);
  let regressed = null;
  for (let i = 0; i < fr.length - 1; i++) {
    if (tier(fr[i]) < tier(fr[i + 1])) { regressed = `${fr[i]} before ${fr[i + 1]}`; break; }
  }
  check("no legacy tag precedes a modern version", !regressed, regressed || "");
}

console.log("search");
{
  const r = await tool("cdnjs_search", { query: "chart.js", limit: 5 });
  const t = r.json?.result?.content?.[0]?.text || "";
  const firstName = (t.split("\n").find((l) => l.includes(" @ ")) || "").split(" @ ")[0];
  check("exact-name match floated to top", firstName === "Chart.js", `got "${firstName}"`);
}

console.log("files + filter");
{
  const r = await tool("cdnjs_files", { name: "Chart.js", version: "4.4.0", filter: ".min.js" });
  const t = r.json?.result?.content?.[0]?.text || "";
  check("only .min.js files", !/\n[a-z0-9.\-]*\.map\n/.test(t));
  check("pins the requested version", t.includes("/Chart.js/4.4.0/"));
}

console.log("error handling");
{
  const r = await tool("cdnjs_library", { name: "definitely-not-a-real-lib-zzz" });
  check("isError set", r.json?.result?.isError === true);
  check("explains case sensitivity", (r.json?.result?.content?.[0]?.text || "").includes("case-sensitive"));
  const u = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } });
  check("unknown tool -> rpc error", u.json?.error?.code === -32602);
  const m = await call({ jsonrpc: "2.0", id: 1, method: "bogus/method" });
  check("unknown method -> -32601", m.json?.error?.code === -32601);
}

console.log("routing");
{
  const health = await worker.fetch(new Request("https://x/"));
  check("GET / is healthy", (await health.json()).status === "ok");
  const wrong = await worker.fetch(new Request("https://x/mcp"));
  check("GET /mcp -> 405", wrong.status === 405);
  const opt = await worker.fetch(new Request("https://x/mcp", { method: "OPTIONS" }));
  check("OPTIONS -> 204 + CORS", opt.status === 204 && opt.headers.get("access-control-allow-origin") === "*");
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);

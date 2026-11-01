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

console.log("GOTCHA 3 — ordering is not guaranteed (three.js legacy r-tags)");
{
  // three.js has 95 inversions in its raw array. Without the semver sort this
  // output is out of order, so this check fails if the sort is removed.
  const r = await tool("cdnjs_versions", { name: "three.js", limit: 100 });
  const t = r.json?.result?.content?.[0]?.text || "";
  const listed = t.split("\n").filter((l) => /^[\dr]/.test(l)).map((l) => l.split("  ")[0].trim());
  const key = (v) => String(v).replace(/^r/, "").split("-")[0].split(".")
    .map((x) => parseInt(x, 10) || 0);
  const cmp = (a, b) => { for (let i = 0; i < 4; i++) { const d = (key(a)[i] || 0) - (key(b)[i] || 0); if (d) return d; } return 0; };
  let bad = null;
  for (let i = 0; i < listed.length - 1; i++) {
    if (cmp(listed[i], listed[i + 1]) < 0) { bad = `${listed[i]} before ${listed[i + 1]}`; break; }
  }
  check("output is monotonically descending", !bad, bad || "");
  check("got a real list", listed.length > 20, `${listed.length} entries`);
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

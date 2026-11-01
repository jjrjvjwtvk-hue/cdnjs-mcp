// cdnjs MCP server — remote, Streamable HTTP, Cloudflare Workers.
//
// A thin read-only proxy over https://api.cdnjs.com. The API is public and
// unauthenticated, so this server holds no secrets and can only read.
//
// It is not a mirror. cdnjs hosts ~4,600 libraries and the API answers "what
// exists" better than any file could. What this adds is the three things the
// raw API gets wrong often enough to matter:
//
//   1. Name lookups are CASE-SENSITIVE. /libraries/chart.js is a 404; the
//      canonical name is "Chart.js". Every lookup here falls back to search
//      and resolves the real name.
//   2. `versions[0]` IS NOT THE CURRENT VERSION. It is usually newest-first,
//      but prereleases sort in front: vue's first entry is 3.6.0-rc.14 while
//      its current release is 3.5.44 — likewise bootstrap (6.0.0-alpha.1 vs
//      5.3.8), recharts and gl-matrix. Take `version` for the current stable,
//      never versions[0]. Verified across 20 libraries 2026-11-01: 4 of 20
//      lead with a prerelease.
//      Ordering is also not guaranteed. 15 of those 20 were already fully
//      descending and the rest invert only in ancient history (jquery
//      1.2.3 -> 1.7) — except three.js, which has 95 inversions from its
//      legacy `r111` tags. Sorted semver-descending here so output is
//      consistent regardless.
//   3. A pinned URL needs name + version + filename, which lives three
//      requests deep. Tools return ready-to-paste URLs with SRI hashes.

const API = "https://api.cdnjs.com";
const CDN = "https://cdnjs.cloudflare.com/ajax/libs";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ── tiny TTL cache ──────────────────────────────────────────────────────────
// Workers are short-lived, so this only collapses bursts within one isolate.
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

async function api(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;
  const res = await fetch(`${API}${path}`, {
    headers: { accept: "application/json", "user-agent": "cdnjs-mcp" },
  });
  const body = await res.json();
  if (body && body.error) {
    const err = new Error(body.message || `cdnjs returned ${res.status}`);
    err.status = body.status || res.status;
    throw err;
  }
  cache.set(path, { at: Date.now(), body });
  return body;
}

// ── semver, descending ──────────────────────────────────────────────────────
// Enough to order real cdnjs version strings. A prerelease sorts below the
// release it qualifies, which is what semver says and what callers expect.
function cmpVersion(a, b) {
  const split = (v) => {
    const [core, pre = ""] = String(v).split("-");
    return [core.split(".").map((n) => parseInt(n, 10) || 0), pre];
  };
  const [ac, ap] = split(a);
  const [bc, bp] = split(b);
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const d = (bc[i] || 0) - (ac[i] || 0);
    if (d) return d;
  }
  if (ap && !bp) return 1;
  if (!ap && bp) return -1;
  return bp.localeCompare(ap);
}

// ── name resolution ─────────────────────────────────────────────────────────
// Direct lookup first; on 404 ask search and take a case-insensitive exact
// match. Search ranking is loose — "chart.js" returns mermaid above Chart.js —
// so an exact match is required rather than trusting first place.
async function resolve(name) {
  try {
    return { name, data: await api(`/libraries/${encodeURIComponent(name)}`) };
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const { results = [] } = await api(
    `/libraries?search=${encodeURIComponent(name)}&fields=name&limit=25`
  );
  const want = name.toLowerCase();
  const exact = results.find((r) => r.name.toLowerCase() === want);
  if (!exact) {
    const near = results.slice(0, 8).map((r) => r.name).join(", ");
    const err = new Error(
      `No library named "${name}". cdnjs names are case-sensitive.` +
        (near ? ` Closest by search: ${near}` : "")
    );
    err.status = 404;
    throw err;
  }
  return {
    name: exact.name,
    data: await api(`/libraries/${encodeURIComponent(exact.name)}`),
    corrected: exact.name !== name ? name : null,
  };
}

function pinnedUrl(name, version, file) {
  return `${CDN}/${name}/${version}/${file}`;
}

// Prefer the minified build of the library's own default file.
function pickDefaultFile(files, filename) {
  if (!files || !files.length) return filename || null;
  const min = filename && filename.replace(/\.(js|css)$/, ".min.$1");
    if (min && files.includes(min)) return min;
  if (filename && files.includes(filename)) return filename;
  return files.find((f) => /\.min\.(js|css)$/.test(f)) || files[0];
}

// ── tools ───────────────────────────────────────────────────────────────────
const TOOLS = {
  cdnjs_search: {
    description:
      "Search the ~4,600 libraries on cdnjs by name or keyword. Returns each " +
      "match's canonical (case-sensitive) name, current version and " +
      "description. Use this when unsure what a library is called; search " +
      "ranking is loose, so check the names rather than taking the first hit.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or keyword, e.g. \"chart\"." },
        limit: { type: "integer", description: "Max results, 1-50. Default 10.", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
    async run({ query, limit = 10 }) {
      const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
      const { results = [], available } = await api(
        `/libraries?search=${encodeURIComponent(query)}&fields=version,description&limit=${n}`
      );
      if (!results.length) return `No cdnjs library matches "${query}".`;
      const want = String(query).toLowerCase();
      results.sort((a, b) => (b.name.toLowerCase() === want) - (a.name.toLowerCase() === want));
      const lines = results.map(
        (r) => `${r.name} @ ${r.version}${r.description ? ` — ${r.description}` : ""}`
      );
      return [
        `${results.length} of ${available} matches for "${query}" (exact-name match first):`,
        "",
        ...lines,
        "",
        'Names are case-sensitive — pass one exactly as shown to cdnjs_library.',
      ].join("\n");
    },
  },

  cdnjs_library: {
    description:
      "Everything cdnjs knows about one library: current version, license, " +
      "homepage, repository, and a ready-to-paste pinned CDN URL with its SRI " +
      "hash. Corrects the name's case automatically, so \"chart.js\" resolves " +
      "to \"Chart.js\" instead of 404ing.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Library name, any case." } },
      required: ["name"],
    },
    async run({ name }) {
      const { name: real, data, corrected } = await resolve(name);
      const latest = (data.assets || []).find((a) => a.version === data.version);
      const file = pickDefaultFile(latest && latest.files, data.filename);
      const sri = latest && latest.sri && file ? latest.sri[file] : null;
      const out = [];
      if (corrected) out.push(`Note: "${corrected}" is not the canonical name. Resolved to "${real}".`, "");
      out.push(
        `${real} @ ${data.version}`,
        data.description || "(no description)",
        "",
        `License:    ${data.license || "unknown"}`,
        `Homepage:   ${data.homepage || "—"}`,
        `Repository: ${(data.repository && data.repository.url) || "—"}`,
        `Versions:   ${(data.versions || []).length} published`,
        ""
      );
      if (file) {
        out.push(`Pinned URL (exact version, safe to paste):`, pinnedUrl(real, data.version, file), "");
        if (sri) out.push(`integrity="${sri}"`, `crossorigin="anonymous" referrerpolicy="no-referrer"`, "");
      }
      out.push("Use cdnjs_files for every file in a version, or cdnjs_versions for the version list.");
      return out.join("\n");
    },
  },

  cdnjs_versions: {
    description:
      "Published versions of a library, newest first, prereleases excluded by " +
      "default. Use this to pick a version. Two traps it handles: the API's " +
      "raw array can LEAD WITH A PRERELEASE (vue's first entry is an rc while " +
      "its current release is older), and ordering is not guaranteed " +
      "(three.js has 95 inversions from legacy r-tags). The current stable is " +
      "always marked.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Library name, any case." },
        limit: { type: "integer", description: "How many newest versions, 1-100. Default 20.", minimum: 1, maximum: 100 },
        include_prereleases: {
          type: "boolean",
          description: "Include alpha/beta/rc/canary builds. Default false — they sort in front and are rarely what you want to pin.",
        },
      },
      required: ["name"],
    },
    async run({ name, limit = 20, include_prereleases = false }) {
      const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const { name: real, data } = await resolve(name);
      const raw = [...(data.versions || [])].sort(cmpVersion);
      const isPre = (v) => /-|\balpha\b|\bbeta\b|\brc\b|canary/i.test(v);
      const all = include_prereleases ? raw : raw.filter((v) => !isPre(v));
      const shown = all.slice(0, n);
      const hidden = raw.length - all.length;
      return [
        `${real} — current stable is ${data.version}.`,
        `${all.length} version(s), newest first` +
          (hidden ? ` (${hidden} prerelease(s) hidden — pass include_prereleases to see them)` : "") + ":",
        "",
        ...shown.map((v) => (v === data.version ? `${v}  ← current` : v)),
        all.length > shown.length ? `\n…and ${all.length - shown.length} older.` : "",
      ].join("\n").trimEnd();
    },
  },

  cdnjs_files: {
    description:
      "Every file in one version of a library, with its SRI hash and full " +
      "pinned cdnjs URL. This is what you need to write a correct script or " +
      "link tag. Omit version to use the current one.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Library name, any case." },
        version: { type: "string", description: "Exact version. Defaults to current." },
        filter: { type: "string", description: "Only files containing this substring, e.g. \".min.js\"." },
      },
      required: ["name"],
    },
    async run({ name, version, filter }) {
      const { name: real, data } = await resolve(name);
      const v = version || data.version;
      let files, sri;
      const inLib = (data.assets || []).find((a) => a.version === v);
      if (inLib) {
        files = inLib.files; sri = inLib.sri || {};
      } else {
        const asset = await api(`/libraries/${encodeURIComponent(real)}/${encodeURIComponent(v)}`);
        files = asset.files || []; sri = asset.sri || {};
      }
      let list = files || [];
      if (filter) list = list.filter((f) => f.includes(filter));
      if (!list.length) {
        return `${real} @ ${v} has no files${filter ? ` matching "${filter}"` : ""}.`;
      }
      const head = list.slice(0, 40);
      const body = head.map((f) => {
        const h = sri[f];
        return `${f}\n  ${pinnedUrl(real, v, f)}${h ? `\n  integrity="${h}"` : ""}`;
      });
      return [
        `${real} @ ${v} — ${list.length} file(s)${filter ? ` matching "${filter}"` : ""}:`,
        "",
        ...body,
        list.length > head.length ? `\n…and ${list.length - head.length} more. Narrow with "filter".` : "",
      ].join("\n").trimEnd();
    },
  },
};

// ── MCP (JSON-RPC 2.0 over Streamable HTTP) ─────────────────────────────────
const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case "initialize": {
      const asked = params && params.protocolVersion;
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "cdnjs", version: "1.0.0" },
        instructions:
          "Read-only access to cdnjs (~4,600 front-end libraries). Use " +
          "cdnjs_search to find a library's canonical name, cdnjs_library for " +
          "its current version and a pinned URL, cdnjs_versions to choose a " +
          "version, cdnjs_files for exact filenames and SRI hashes. Always " +
          "reference an exact version in HTML; never a bare name or major-only " +
          "range.",
      });
    }
    case "ping":
      return rpcOk(id, {});
    case "tools/list":
      return rpcOk(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const tool = TOOLS[params && params.name];
      if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params && params.name}`);
      try {
        const text = await tool.run((params && params.arguments) || {});
        return rpcOk(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // A tool failure is a result, not a transport error — the model should
        // see it and be able to correct the call.
        return rpcOk(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (String(method || "").startsWith("notifications/")) return null;
      return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json(
        { name: "cdnjs-mcp", status: "ok", endpoint: "/mcp", tools: Object.keys(TOOLS) },
        { headers: CORS }
      );
    }

    if (url.pathname !== "/mcp") {
      return Response.json({ error: "Not found. MCP endpoint is POST /mcp." }, { status: 404, headers: CORS });
    }
    if (request.method !== "POST") {
      return Response.json(
        rpcErr(null, -32600, "Use POST for MCP requests."),
        { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } }
      );
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400, headers: CORS });
    }

    // A batch is a JSON array; notifications produce no reply.
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map(handleRpc))).filter(Boolean);
      return out.length
        ? Response.json(out, { headers: CORS })
        : new Response(null, { status: 202, headers: CORS });
    }

    const reply = await handleRpc(payload);
    return reply
      ? Response.json(reply, { headers: CORS })
      : new Response(null, { status: 202, headers: CORS });
  },
};

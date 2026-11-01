cdnjs-mcp
An MCP server that gives an LLM live,
read-only access to cdnjs — all ~4,600 front-end
libraries, with canonical names, version histories, exact filenames and SRI
hashes. Deploys to Cloudflare Workers.
It exists so an assistant writing a <script> tag can look up the version
instead of recalling one. A model's training data goes stale silently; a wrong
pin either 404s or quietly serves something years old.
Unofficial. Not affiliated with, endorsed by, or operated by cdnjs or
Cloudflare. It is a third-party client for the public cdnjs API.
Tools
Tool
Answers
cdnjs_search
What is this library actually called?
cdnjs_library
Current version, license, homepage, and a pinned URL with its SRI hash
cdnjs_versions
Which versions exist, newest first, prereleases hidden by default
cdnjs_files
Exact filenames in a version, each with its SRI hash and full URL
Quick start
Deploy your own. It takes about a minute and needs no secrets.
git clone <https://github.com/jjrjvjwtvk-hue/cdnjs-mcp> && cd cdnjs-mcp
​
npm install && npx wrangler login
​
npm run deploy
​
npm run deploy runs the tests first and refuses to deploy if they fail.
Then add the printed URL to your MCP client with /mcp on the end:
https://cdnjs-mcp.<your-subdomain>.workers.dev/mcp
​
For Claude, that goes in Settings → Connectors → Add custom connector. A plain
GET / returns a health check if you want to confirm it's up first.
Please deploy your own rather than pointing at someone else's URL. Every
call costs the operator Worker invocations and spends cdnjs's free bandwidth.
Why a server rather than a static file
Worth stating, because "put the reference material in a file" is the obvious
first instinct and it doesn't work here:
Why not
A bundled list or prompt
4,600 libraries don't fit, and the data is stale the moment it's written
A documentation page
Describes the API; doesn't answer a specific question at the moment it's asked
A live proxy
Always current, no cache to drift, and the whole catalog is reachable
The general rule: don't cache what an upstream API answers authoritatively.
Keep in your own layer only the things the API gets wrong.
The three traps
This is what the proxy is actually for. A plain curl against the cdnjs API
hits all three. Each was verified against the live API on 2026-11-01, and each
has a test that fails if the handling is removed.
1. Library names are case-sensitive
GET /libraries/chart.js returns 404 Library not found. The canonical name
is Chart.js.
Every lookup here falls back to search and takes a case-insensitive exact
match, then tells you the name was corrected. The top search hit is not
trustworthy — searching chart.js returns mermaid above Chart.js — so an
exact match is required rather than first place.
2. versions[0] is not the current version
Prereleases sort in front. Of 20 popular libraries sampled, 4 lead with
one:
Library
versions[0]
Actual current release
vue
3.6.0-rc.14
3.5.44
bootstrap
6.0.0-alpha.1
5.3.8
recharts
3.11.0-canary.8
3.10.1
gl-matrix
4.0.0-beta.2
3.4.4
Take the version field for the current stable, never versions[0]. Pin from
versions[0] and you can ship a canary build to production.
cdnjs_versions hides prereleases unless you ask for them, and always marks
the current stable.
3. Version ordering is not guaranteed
15 of those 20 arrays were already fully descending, and the rest invert only
deep in ancient history (jquery lists 1.2.3 before 1.7). The exception is
three.js, with 95 inversions, from its legacy r111-style tags sitting
alongside semver.
Sorted semver-descending here, so output is consistent whichever library you
ask about.
Tests
npm test
​
23 checks against the live cdnjs API — protocol handshake, all four tools,
each of the three traps, error handling, routing and CORS. No mocks, so an
upstream API change surfaces in the test run rather than in production. The
tradeoff is that the suite needs network and can fail for reasons that aren't
your fault.
Each trap-handler is mutation-tested. Remove the semver sort and the
three.js ordering check fails; drop the prerelease filter and three vue checks
fail; drop the case-insensitive resolution and five Chart.js checks fail.
That mattered: the first version of this suite passed when the sort was
deleted, because the check was reading versions[0] — which is newest anyway,
so it asserted nothing. A check that cannot fail is decoration. If the suite
ever goes a long stretch without catching anything, break something on purpose
and confirm it still bites.
A gotcha in the tooling itself
node --check src/index.js will not catch a syntax error here. It parses a
.js file as CommonJS, and this is an ES module; during development it passed
a file with an unclosed argument list. Use:
node --input-type=module --check < src/index.js
​
How it works
A single Worker, no bindings and no stored state. POST /mcp speaks JSON-RPC
2.0 over Streamable HTTP; GET / is a health check. Requests to cdnjs are
cached in-process for five minutes, which only collapses bursts inside one
isolate — there is no shared cache to go stale.
The cdnjs API is public, unauthenticated and read-only, so this server holds no
credentials, needs no OAuth, and cannot write anything anywhere.
src/index.js     the whole server
test/local.mjs   the suite — runs the handler directly, no wrangler needed
wrangler.toml    name, entrypoint, compatibility date. No bindings
​
Contributing
Issues and pull requests welcome. Two asks: run npm test before opening a PR,
and if you add handling for an upstream quirk, add a test that fails without it
— this repo's whole premise is that unverified checks are worse than none.
If the cdnjs API changes shape, the test suite is the place it will show up
first.
License
MIT.

# @pipeworx/blm-mining-claims

US federal mining claims from the Bureau of Land Management's Mineral and Land Records System (MLRS): claims near a point or inside a box, one claim by case serial number, and claim counts by type and status around a site. Each result has the case serial, claim name, lode/placer/mill-site/tunnel-site type, status, recorded acres, the PLSS legal land description and a link to the MLRS case record.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1875+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `blm_claims_near(latitude, longitude, radius_km?, status?, claim_type?, limit?, after_object_id?)`: claims within a radius (max 50 km) of a point, with the total count in the radius. Each page is sorted by distance. Use it to see who has staked ground around a lithium, gold or uranium deposit.
- `blm_claims_in_bbox(min_lat, min_lon, max_lat, max_lon, status?, claim_type?, limit?, after_object_id?)`: the same for a bounding box of up to 2° on a side.
- `blm_claims_case(case_id)`: one case by MLRS serial (`NV101474832`) or legacy serial (`NMC1018964`). Returns type, status, acres, patented/excluded/conveyed flags, the parsed PLSS legal land description (meridian, township, range, section, aliquot part), the mapped bounding box, BLM's mapping-quality log and the MLRS link.
- `blm_claims_summary(latitude, longitude, radius_km?, status?)`: counts and total recorded acres by claim type and status within a radius.

`status` accepts `open` (default: every case not closed, including Active, Filed, Under Review and On Appeal), `active` (disposition exactly Active), `closed` or `all`. `claim_type` accepts `lode`, `placer`, `mill_site` or `tunnel_site`.

## Auth

Keyless.

## Data sources

- <https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer>: BLM MLRS mining-claim case layer (ArcGIS MapServer). Layer 0 holds every case, layer 1 holds cases that are not closed, and layer 2 holds closed cases. Each call queries the service live.
- <https://mlrs.blm.gov/>: the MLRS case record that `mlrs_case_url` opens.

Things the next person would otherwise rediscover:

- **The geometry is not the staked boundary.** BLM maps each case's recorded Legal Land Description onto the PLSS cadastral grid, so a 20-acre lode claim appears as the aliquot part(s) it was recorded in. The `QLTY` score says how well the mapping worked. `geometry_basis` turns it into words: direct PLSS match, calculated, section-only, county-only, no geometry, or hand-edited by BLM.
- **The layer has no location date, claimant names or claimant count.** Those fields exist only in the MLRS case record. The tools say so in `fields_not_in_layer` rather than returning nulls.
- **No as-of date is published.** The service carries no editingInfo or documentInfo date, so `data_as_of` is the time of the live query and `data_as_of_basis` says that.
- **`orderByFields` is very slow:** 30–60 s against about 5 s without it, measured 2026-10-08. Rows come back in OBJECTID order, so paging uses an OBJECTID cursor (`after_object_id` → `next_after_object_id`).
- **`resultOffset` is off by one on spatial queries.** Offset 0 returns one row short, and offset *k* starts at row *k*−1. Paging by offset would repeat or skip a claim, which is why this pack uses the cursor instead.
- `BLM_PROD` capitalization varies (`Lode Claim` and `LODE CLAIM` both occur), so type filters match on `UPPER(BLM_PROD) LIKE 'LODE CLAIM%'`, which also includes the "– National Park" variants.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "blm-mining-claims": {
      "url": "https://gateway.pipeworx.io/blm-mining-claims/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/blm-mining-claims/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1875+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/blm_claims_near \
  -H 'Content-Type: application/json' \
  -d '{"latitude":41.71,"longitude":-118.06,"radius_km":10,"limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/blm_claims_near`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "blm-mining-claims": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-blm-mining-claims"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-blm-mining-claims
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Blm Mining Claims data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

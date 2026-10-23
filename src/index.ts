interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * BLM mining claims (MLRS) — fleet #2826.
 *
 * SOURCE. The Bureau of Land Management's Mineral and Land Records System
 * (MLRS) mining-claim case layer, published as a keyless ArcGIS MapServer:
 *   https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer
 *     layer 0  every case (any disposition)        ~4.4M rows
 *     layer 1  "Active Mining Claims" — every case NOT closed: Active, Filed,
 *              Under Review, Submitted, On Appeal, …   ~593k rows
 *     layer 2  "Closed Mining Claims"                ~3.8M rows
 * (counts measured live 2026-10-08). Proxied per request — a live call per
 * request needs no reuse grant (root CLAUDE.md, "PROXYING is not
 * REDISTRIBUTING"); US federal data. No bake, no module-scope table.
 *
 * WHAT THE GEOMETRY IS — the task asked us to say, and every response does.
 * BLM does NOT publish staked claim boundaries here. Each polygon is the
 * case's Legal Land Description (PLSS township/range/section/aliquot parts)
 * geocoded onto the cadastral survey grid, so a 20-acre lode claim is drawn as
 * the quarter-quarter section(s) it was recorded in. The QLTY field carries a
 * score that says how well that mapping went (direct PLSS match, calculated,
 * mapped only to the section, only to the county, or hand-edited by BLM staff);
 * `geometry_basis` reports it per claim.
 *
 * WHAT IS NOT IN THE PUBLIC LAYER, said plainly rather than nulled silently:
 * location date, claimant names and claimant count are MLRS case-record
 * fields that this GIS service does not expose. The `mlrs_case_url` on every
 * claim opens the full case record (claimants, dates, fee status) on MLRS.
 *
 * AS-OF. The service publishes no edit or refresh date (no editingInfo, no
 * documentInfo date — checked 2026-10-08), so `data_as_of` is the moment of
 * the live query and `data_as_of_basis` says so rather than inventing a date.
 *
 * Failures throw LOUD with the upstream status — a transport or parse failure
 * must never read as "no claims here".
 */


const UA = 'pipeworx-mcp-blm-mining-claims/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'BLM MLRS mining claims (ArcGIS MapServer)';
const SERVICE_URL = 'https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer';
const SOURCE_LABEL = 'US Bureau of Land Management, Mineral and Land Records System (MLRS) mining-claim cases, keyless';
const AS_OF_BASIS =
  'Live query of the BLM MLRS mining-claim service at this time; BLM publishes no refresh date for the layer.';
const GEOMETRY_BASIS_NOTE =
  'Claim geometry is the recorded Legal Land Description (PLSS township/range/section/aliquot) mapped onto the BLM cadastral grid — NOT the staked claim boundary on the ground.';
const NOT_IN_LAYER_NOTE =
  'Location date, claimant names and claimant count are MLRS case-record fields not published in the BLM GIS layer; open mlrs_case_url for them.';

const LAYERS = { all: 0, open: 1, closed: 2 } as const;
type Status = 'open' | 'active' | 'closed' | 'all';

const CLAIM_TYPES: Record<string, string> = {
  lode: 'LODE CLAIM',
  placer: 'PLACER CLAIM',
  mill_site: 'MILL SITE',
  tunnel_site: 'TUNNEL SITE',
};

const LIST_FIELDS = 'OBJECTID,CSE_NR,LEG_CSE_NR,CSE_NAME,BLM_PROD,CSE_DISP,RCRD_ACRS,QLTY,SF_ID,MC_PATENTED';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

interface ArcGisFeature {
  attributes: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
}
interface ArcGisResponse {
  features?: ArcGisFeature[];
  count?: number;
  exceededTransferLimit?: boolean;
  error?: { code?: number; message?: string; details?: string[] };
}

async function arcgisQuery(layer: number, params: Record<string, string>): Promise<ArcGisResponse> {
  const qs = new URLSearchParams({ f: 'json', ...params }).toString();
  const res = await pwFetch(`${SERVICE_URL}/${layer}/query?${qs}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const data = await parseJson<ArcGisResponse>(res, UPSTREAM);
  if (data.error) {
    throw new Error(
      `BLM MLRS mining-claim service rejected the query (code ${data.error.code ?? 'unknown'}): ${data.error.message ?? 'no message'}${data.error.details?.length ? ` — ${data.error.details.join('; ')}` : ''}.`,
    );
  }
  return data;
}

// ── input handling ──────────────────────────────────────────────────────────

function num(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

function optNum(v: unknown, name: string, min: number, max: number, dflt: number): number {
  return v === undefined || v === null || v === '' ? dflt : num(v, name, min, max);
}

function parseStatus(v: unknown): Status {
  if (v === undefined || v === null || v === '') return 'open';
  const s = String(v).toLowerCase().trim();
  if (s === 'open' || s === 'active' || s === 'closed' || s === 'all') return s;
  throw new Error(`status must be one of open, active, closed, all (got "${v}")`);
}

function layerAndWhere(status: Status, claimType: unknown): { layer: number; where: string } {
  const clauses: string[] = [];
  let layer: number = LAYERS.open;
  if (status === 'closed') layer = LAYERS.closed;
  else if (status === 'all') layer = LAYERS.all;
  else if (status === 'active') clauses.push("CSE_DISP = 'Active'");
  if (claimType !== undefined && claimType !== null && claimType !== '') {
    const key = String(claimType).toLowerCase().trim().replace(/[\s-]+/g, '_');
    const prefix = CLAIM_TYPES[key];
    if (!prefix) throw new Error(`claim_type must be one of ${Object.keys(CLAIM_TYPES).join(', ')} (got "${claimType}")`);
    clauses.push(`UPPER(BLM_PROD) LIKE '${prefix}%'`);
  }
  return { layer, where: clauses.length ? clauses.join(' AND ') : '1=1' };
}

// ── shaping ─────────────────────────────────────────────────────────────────

/** QLTY starts with the score ("1: SIMPLE\n…"); BLM groups scores into seven bands. */
function geometryBasis(qlty: unknown): { score: string | null; basis: string } {
  const raw = typeof qlty === 'string' ? qlty : '';
  const m = raw.match(/^\s*([\d.]+)/);
  if (!m) return { score: null, basis: 'unknown — no data-quality score on the case' };
  const s = parseFloat(m[1]);
  let basis: string;
  if (s === 100) basis = 'improved geometry — edited by BLM staff';
  else if (s === 25) basis = 'mapped to the county only';
  else if ([11, 12, 20, 21, 22].includes(s)) basis = 'no geometry — attributes only, could not be mapped to PLSS';
  else if (s === 15) basis = 'partly mapped — some legal descriptions mapped, others did not';
  else if (s >= 8.1 && s <= 10) basis = 'mapped to the whole PLSS section';
  else if (s >= 4 && s <= 8) basis = 'calculated from the PLSS grid (best guess)';
  else if (s >= 0 && s <= 3) basis = 'direct PLSS match';
  else basis = 'unrecognised score';
  return { score: m[1], basis };
}

const MERIDIANS: Record<string, string> = {
  '01': '1st Principal', '02': '2nd Principal', '03': '3rd Principal', '04': '4th Principal', '05': '5th Principal',
  '06': '6th Principal', '07': 'Black Hills', '08': 'Boise', '10': 'Chickasaw', '11': 'Choctaw', '12': 'Cimarron',
  '14': 'Fairbanks', '15': 'Gila and Salt River', '16': 'Humboldt', '17': 'Huntsville', '18': 'Indian', '19': 'Louisiana',
  '20': 'Michigan', '21': 'Mount Diablo', '22': 'Navajo', '23': 'New Mexico Principal', '24': 'St. Helena',
  '25': 'St. Stephens', '26': 'Salt Lake', '27': 'San Bernardino', '28': 'Seward', '29': 'Tallahassee',
  '30': 'Uintah Special', '31': 'Ute', '32': 'Washington', '33': 'Willamette', '34': 'Wind River', '35': 'Ohio River Survey',
  '44': 'Copper River', '45': 'Kateel River', '46': 'Umiat', '48': 'Montana Principal',
};

/** CSE_META: "NV 21 0440N 0340E 013 A NW|…" → state, meridian, township, range, section, survey type, part. */
function parseLegalDescriptions(meta: unknown): Array<Record<string, string | null>> {
  if (typeof meta !== 'string' || !meta.trim()) return [];
  return meta.split('|').map((part) => {
    const t = part.trim().split(/\s+/);
    const fmt = (s: string | undefined) => {
      if (!s) return null;
      const m = s.match(/^0*(\d+?)(\d)([NSEW])$/);
      // last digit is BLM's fraction code: 1 = ¼, 2 = ½, 3 = ¾
      const frac: Record<string, string> = { '1': ' 1/4', '2': ' 1/2', '3': ' 3/4' };
      return m ? `${m[1] || '0'}${frac[m[2]] ?? ''}${m[3]}` : s;
    };
    return {
      state: t[0] ?? null,
      meridian_code: t[1] ?? null,
      meridian: t[1] ? MERIDIANS[t[1]] ?? null : null,
      township: fmt(t[2]),
      range: fmt(t[3]),
      section: t[4] ? String(parseInt(t[4], 10)) : null,
      survey_type: t[5] === 'A' ? 'aliquot' : t[5] ?? null,
      aliquot_part: t.slice(6).join(' ') || null,
      raw: part.trim(),
    };
  });
}

function bboxOf(rings: number[][][] | undefined): { min_lon: number; min_lat: number; max_lon: number; max_lat: number } | null {
  if (!rings?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
  return { min_lon: r5(minX), min_lat: r5(minY), max_lon: r5(maxX), max_lat: r5(maxY) };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function mlrsUrl(sfId: unknown): string | null {
  return typeof sfId === 'string' && /^[A-Za-z0-9]{15,18}$/.test(sfId) ? `https://mlrs.blm.gov/s/blm-case/${sfId}` : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function shapeClaim(f: ArcGisFeature, origin?: { lat: number; lon: number }) {
  const a = f.attributes;
  const gb = geometryBasis(a.QLTY);
  const bbox = bboxOf(f.geometry?.rings);
  const center = bbox ? { lat: Math.round(((bbox.min_lat + bbox.max_lat) / 2) * 1e5) / 1e5, lon: Math.round(((bbox.min_lon + bbox.max_lon) / 2) * 1e5) / 1e5 } : null;
  const out: Record<string, unknown> = {
    case_id: str(a.CSE_NR),
    legacy_case_id: str(a.LEG_CSE_NR),
    claim_name: str(a.CSE_NAME),
    claim_type: a.BLM_PROD ?? null,
    status: a.CSE_DISP ?? null,
    acres: typeof a.RCRD_ACRS === 'number' ? a.RCRD_ACRS : null,
    patented: a.MC_PATENTED === 'Y' ? true : a.MC_PATENTED === 'N' ? false : null,
    geometry_basis: gb.basis,
    data_quality_score: gb.score,
    mapped_center: center,
    mlrs_case_url: mlrsUrl(a.SF_ID),
  };
  if (origin && center) out.distance_km = Math.round(haversineKm(origin.lat, origin.lon, center.lat, center.lon) * 100) / 100;
  return out;
}

function envelope() {
  return {
    data_as_of: new Date().toISOString(),
    data_as_of_basis: AS_OF_BASIS,
    geometry_note: GEOMETRY_BASIS_NOTE,
    fields_not_in_layer: NOT_IN_LAYER_NOTE,
    source: SOURCE_LABEL,
    source_url: SERVICE_URL,
  };
}

// ── spatial queries ─────────────────────────────────────────────────────────

interface SpatialQuery {
  geometry: string;
  geometryType: string;
  extra?: Record<string, string>;
}

async function listClaims(
  sq: SpatialQuery,
  status: Status,
  claimType: unknown,
  limit: number,
  afterId: number,
  origin?: { lat: number; lon: number },
) {
  const { layer, where } = layerAndWhere(status, claimType);
  const common = {
    where,
    geometry: sq.geometry,
    geometryType: sq.geometryType,
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    ...(sq.extra ?? {}),
  };
  // HOW PAGING WORKS, and why it is not resultOffset/resultRecordCount.
  // On this service a spatial query with resultRecordCount returns an
  // arbitrary FRACTION of the page it was asked for — 0 of 7, 63 of 100,
  // 1,693 of 2,000 on the closed layer around Thacker Pass where the count is
  // 3,758 (measured 2026-10-08), with exceededTransferLimit:true and no
  // error. That is a silent zero waiting to happen. returnIdsOnly, by
  // contrast, returns every matching OBJECTID (3,758 of 3,758; 101,761 for a
  // 50 km radius in 2.8 s), and a query by explicit objectIds returns every
  // row asked for. So: ids first, sort, cursor past after_object_id, then
  // fetch exactly that page by id. orderByFields is avoided entirely — it
  // turns a sub-second query into 30-60 s on this service.
  const idsRes = await arcgisQuery(layer, { ...common, returnIdsOnly: 'true' }) as ArcGisResponse & {
    objectIds?: number[] | null;
    objectIdFieldName?: string;
  };
  if (!idsRes.objectIdFieldName && !Array.isArray(idsRes.objectIds)) {
    throw new Error('BLM MLRS mining-claim service returned no id list for the area — treating as a fault, not a zero.');
  }
  const ids = (idsRes.objectIds ?? []).slice().sort((x, y) => x - y);
  const total = ids.length;
  const pageIds = ids.filter((id) => id > afterId).slice(0, limit);
  let features: ArcGisFeature[] = [];
  if (pageIds.length) {
    const page = await arcgisQuery(layer, {
      objectIds: pageIds.join(','),
      outFields: LIST_FIELDS,
      returnGeometry: 'true',
      outSR: '4326',
      maxAllowableOffset: '0.0005',
      geometryPrecision: '5',
    });
    features = page.features ?? [];
    if (features.length === 0) {
      throw new Error(
        `BLM MLRS mining-claim service listed ${total} claims in the area but returned none of the ${pageIds.length} requested by id — an upstream fault, not an empty area.`,
      );
    }
  }
  const lastId = pageIds.length ? pageIds[pageIds.length - 1] : afterId;
  const hasMore = ids.some((id) => id > lastId);
  const nextAfter = hasMore ? lastId : null;
  const missing = pageIds.length - features.length;
  const rows = { features };
  const claims = (rows.features ?? []).map((f) => shapeClaim(f, origin));
  if (origin) claims.sort((x, y) => ((x.distance_km as number) ?? 1e9) - ((y.distance_km as number) ?? 1e9));
  return { layer, where, total, claims, hasMore, nextAfter, missing };
}

function typeBreakdown(claims: Array<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of claims) {
    const k = String(c.claim_type ?? 'unknown');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ── tools ───────────────────────────────────────────────────────────────────

const STATUS_PROP = {
  type: 'string',
  enum: ['open', 'active', 'closed', 'all'],
  description:
    'Which claims: "open" (default — every claim not closed: Active, Filed, Under Review, On Appeal…), "active" (disposition exactly Active), "closed", or "all".',
};
const TYPE_PROP = {
  type: 'string',
  enum: ['lode', 'placer', 'mill_site', 'tunnel_site'],
  description: 'Optional claim type filter: lode, placer, mill_site or tunnel_site.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'blm_claims_near',
    description:
      'US federal mining claims (BLM MLRS) within a radius of a latitude/longitude — e.g. claims staked around a lithium, gold or uranium deposit in Nevada, Arizona, Utah, Wyoming. Returns the total count in the radius plus a page of claims (each page sorted by distance): BLM case serial number, claim name, type (lode / placer / mill site / tunnel site), status (Active, Filed, Closed…), recorded acres, distance, and an MLRS case-record link. Geometry is the recorded PLSS land description, not the staked boundary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: { type: 'number', description: 'Latitude (WGS84), e.g. 41.71' },
        longitude: { type: 'number', description: 'Longitude (WGS84), e.g. -118.06' },
        radius_km: { type: 'number', description: 'Search radius in km, 0.1–50 (default 5)' },
        status: STATUS_PROP,
        claim_type: TYPE_PROP,
        limit: { type: 'number', description: 'Claims to return, 1–500 (default 50)' },
        after_object_id: { type: 'number', description: 'Paging cursor: pass next_after_object_id from the previous page (default: first page)' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'blm_claims_in_bbox',
    description:
      'US federal mining claims (BLM MLRS) inside a latitude/longitude bounding box (up to 2° on a side). Returns the total count in the box and a page of claims: BLM case serial number, claim name, lode/placer/mill-site type, status, acres, mapped center and an MLRS case-record link.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        min_lat: { type: 'number', description: 'South edge latitude' },
        min_lon: { type: 'number', description: 'West edge longitude' },
        max_lat: { type: 'number', description: 'North edge latitude' },
        max_lon: { type: 'number', description: 'East edge longitude' },
        status: STATUS_PROP,
        claim_type: TYPE_PROP,
        limit: { type: 'number', description: 'Claims to return, 1–500 (default 50)' },
        after_object_id: { type: 'number', description: 'Paging cursor: pass next_after_object_id from the previous page (default: first page)' },
      },
      required: ['min_lat', 'min_lon', 'max_lat', 'max_lon'],
    },
  },
  {
    name: 'blm_claims_case',
    description:
      'One BLM mining claim by case serial number (MLRS, e.g. "NV101474832") or legacy serial (e.g. "NMC1018964"): claim name, type, status, recorded acres, patented flag, the full PLSS legal land description (meridian, township, range, section, aliquot parts), how well BLM could map it, the mapped bounding box, and the MLRS case-record link.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'string', description: 'MLRS case serial number (e.g. NV101474832) or legacy serial (e.g. NMC1018964)' },
      },
      required: ['case_id'],
    },
  },
  {
    name: 'blm_claims_summary',
    description:
      'Counts of US federal mining claims (BLM MLRS) within a radius of a point, broken down by claim type and status, with total recorded acres — how heavily staked is the ground around a deposit or project site, and how much of it is active versus closed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: { type: 'number', description: 'Latitude (WGS84)' },
        longitude: { type: 'number', description: 'Longitude (WGS84)' },
        radius_km: { type: 'number', description: 'Radius in km, 0.1–50 (default 10)' },
        status: STATUS_PROP,
      },
      required: ['latitude', 'longitude'],
    },
  },
];

async function claimsNear(args: Record<string, unknown>) {
  const lat = num(args.latitude, 'latitude', -90, 90);
  const lon = num(args.longitude, 'longitude', -180, 180);
  const radius = optNum(args.radius_km, 'radius_km', 0.1, 50, 5);
  const limit = Math.floor(optNum(args.limit, 'limit', 1, 500, 50));
  const afterId = Math.floor(optNum(args.after_object_id, 'after_object_id', 0, 1e10, 0));
  const status = parseStatus(args.status);
  const r = await listClaims(
    { geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', extra: { distance: String(radius), units: 'esriSRUnit_Kilometer' } },
    status, args.claim_type, limit, afterId, { lat, lon },
  );
  const query = { latitude: lat, longitude: lon, radius_km: radius, status, claim_type: args.claim_type ?? null };
  if (r.total === 0) {
    return {
      found: false,
      reason: 'no_claims_in_radius',
      hint: 'BLM records no mining claims of this status within the radius. Widen radius_km (max 50), try status "all", or check the point is on federal land in a western public-land state.',
      query,
      total: 0,
      ...envelope(),
    };
  }
  return {
    found: true,
    query,
    total: r.total,
    returned: r.claims.length,
    has_more: r.hasMore,
    next_after_object_id: r.nextAfter,
    ...(r.missing > 0 ? { rows_not_returned_by_upstream: r.missing } : {}),
    by_type_in_page: typeBreakdown(r.claims),
    ordering: 'Pages follow BLM\'s record order (page on with next_after_object_id); claims within this page are sorted by distance from the point. Use blm_claims_summary for totals by type and status.',
    claims: r.claims,
    ...envelope(),
  };
}

async function claimsInBbox(args: Record<string, unknown>) {
  const minLat = num(args.min_lat, 'min_lat', -90, 90);
  const maxLat = num(args.max_lat, 'max_lat', -90, 90);
  const minLon = num(args.min_lon, 'min_lon', -180, 180);
  const maxLon = num(args.max_lon, 'max_lon', -180, 180);
  if (minLat >= maxLat || minLon >= maxLon) throw new Error('bounding box needs min_lat < max_lat and min_lon < max_lon');
  if (maxLat - minLat > 2 || maxLon - minLon > 2) throw new Error('bounding box may be at most 2 degrees on a side — split a larger area');
  const limit = Math.floor(optNum(args.limit, 'limit', 1, 500, 50));
  const afterId = Math.floor(optNum(args.after_object_id, 'after_object_id', 0, 1e10, 0));
  const status = parseStatus(args.status);
  const r = await listClaims(
    { geometry: `${minLon},${minLat},${maxLon},${maxLat}`, geometryType: 'esriGeometryEnvelope' },
    status, args.claim_type, limit, afterId,
  );
  const query = { min_lat: minLat, min_lon: minLon, max_lat: maxLat, max_lon: maxLon, status, claim_type: args.claim_type ?? null };
  if (r.total === 0) {
    return {
      found: false,
      reason: 'no_claims_in_bbox',
      hint: 'BLM records no mining claims of this status in the box. Try status "all" or a box over federal land in a western public-land state.',
      query,
      total: 0,
      ...envelope(),
    };
  }
  return {
    found: true,
    query,
    total: r.total,
    returned: r.claims.length,
    has_more: r.hasMore,
    next_after_object_id: r.nextAfter,
    ...(r.missing > 0 ? { rows_not_returned_by_upstream: r.missing } : {}),
    by_type_in_page: typeBreakdown(r.claims),
    claims: r.claims,
    ...envelope(),
  };
}

async function claimCase(args: Record<string, unknown>) {
  const id = String(args.case_id ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (!id) throw new Error('case_id is required');
  if (!/^[A-Z0-9]{3,20}$/.test(id)) throw new Error(`case_id must be letters and digits, e.g. NV101474832 or NMC1018964 (got "${args.case_id}")`);
  const data = await arcgisQuery(LAYERS.all, {
    where: `CSE_NR = '${id}' OR LEG_CSE_NR = '${id}'`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
  });
  const feats = data.features ?? [];
  if (feats.length === 0) {
    return {
      found: false,
      reason: 'case_not_found',
      hint: 'No BLM mining-claim case carries that serial. MLRS serials look like NV101474832; legacy serials like NMC1018964. Find serials with blm_claims_near.',
      case_id: id,
      ...envelope(),
    };
  }
  const cases = feats.map((f) => {
    const a = f.attributes;
    const base = shapeClaim(f);
    const qlty = typeof a.QLTY === 'string' ? a.QLTY.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    return {
      ...base,
      case_group: typeof a.REC_TYPE_CSE_GRP === 'string' ? a.REC_TYPE_CSE_GRP.trim() : null,
      product_code: a.CSE_TYPE_NR ?? null,
      excluded: a.MC_EXCLUDED === 'Y' ? true : a.MC_EXCLUDED === 'N' ? false : null,
      conveyed: a.MC_CONVEYED === 'Y' ? true : a.MC_CONVEYED === 'N' ? false : null,
      data_source: a.SRC ?? null,
      legal_land_description: parseLegalDescriptions(a.CSE_META),
      mapped_bbox: bboxOf(f.geometry?.rings),
      mapped_polygon_parts: f.geometry?.rings?.length ?? 0,
      mapping_log: qlty.slice(1),
    };
  });
  return { found: true, case_id: id, matches: cases.length, cases, ...envelope() };
}

async function claimsSummary(args: Record<string, unknown>) {
  const lat = num(args.latitude, 'latitude', -90, 90);
  const lon = num(args.longitude, 'longitude', -180, 180);
  const radius = optNum(args.radius_km, 'radius_km', 0.1, 50, 10);
  const status = parseStatus(args.status);
  const { layer, where } = layerAndWhere(status, undefined);
  const stats = JSON.stringify([
    { statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' },
    { statisticType: 'sum', onStatisticField: 'RCRD_ACRS', outStatisticFieldName: 'acres' },
  ]);
  const data = await arcgisQuery(layer, {
    where,
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(radius),
    units: 'esriSRUnit_Kilometer',
    groupByFieldsForStatistics: 'BLM_PROD,CSE_DISP',
    outStatistics: stats,
  });
  // BLM_PROD case varies ("Lode Claim" vs "LODE CLAIM") — fold to one label.
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const rows: Record<string, { claim_type: string; status: string; claims: number; acres: number }> = {};
  let total = 0, acres = 0;
  for (const f of data.features ?? []) {
    const a = f.attributes;
    const type = String(a.BLM_PROD ?? 'Unknown').trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const st = String(a.CSE_DISP ?? 'Unknown');
    const n = Number(a.n ?? 0), ac = Number(a.acres ?? 0);
    total += n; acres += ac;
    byType[type] = (byType[type] ?? 0) + n;
    byStatus[st] = (byStatus[st] ?? 0) + n;
    const k = `${type}|${st}`;
    rows[k] = rows[k] ?? { claim_type: type, status: st, claims: 0, acres: 0 };
    rows[k].claims += n; rows[k].acres += ac;
  }
  const query = { latitude: lat, longitude: lon, radius_km: radius, status };
  if (total === 0) {
    return {
      found: false,
      reason: 'no_claims_in_radius',
      hint: 'BLM records no mining claims of this status within the radius. Widen radius_km (max 50) or try status "all".',
      query,
      total_claims: 0,
      ...envelope(),
    };
  }
  return {
    found: true,
    query,
    total_claims: total,
    total_recorded_acres: Math.round(acres * 100) / 100,
    by_type: byType,
    by_status: byStatus,
    breakdown: Object.values(rows)
      .map((r) => ({ ...r, acres: Math.round(r.acres * 100) / 100 }))
      .sort((x, y) => y.claims - x.claims),
    note: 'Acres are as recorded on each case; overlapping and amended claims can make the sum exceed the ground area.',
    ...envelope(),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'blm_claims_near':
      return claimsNear(args);
    case 'blm_claims_in_bbox':
      return claimsInBbox(args);
    case 'blm_claims_case':
      return claimCase(args);
    case 'blm_claims_summary':
      return claimsSummary(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

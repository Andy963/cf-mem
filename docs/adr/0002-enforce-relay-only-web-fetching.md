# ADR 0002: Enforce Relay-Only Webpage Fetching

## Status

Accepted

## Context

`/web/extract` originally preferred the Tavily relay but fetched URLs directly
from the Worker when the relay was unavailable or omitted a result. The Worker
could reject obvious local addresses, but it could not resolve and pin a
hostname before its outbound `fetch()` call. A public hostname could therefore
resolve to a private address after application-level validation.

The direct path also duplicated redirect handling, response-size limits, body
decoding, and HTML cleanup inside the Worker. Those controls did not provide a
reliable network boundary and made the page-fetching contract harder to audit.

## Decision

1. Route every valid webpage URL through the authenticated Tavily extract
   relay. The Worker must never fetch a user-provided webpage URL directly.
2. Keep only deterministic input validation in the Worker: URL parsing,
   HTTP(S) scheme, standard ports, no credentials, and rejection of obvious
   local or literal-IP targets before relay submission.
3. Return `tavily_relay_required` when the relay is not configured. Return
   `url_fetch_unavailable` when the relay is unavailable or does not return a
   requested URL.
4. Keep failures attached to individual URLs so memory ingestion can skip an
   unavailable page without failing the surrounding conversation batch.
5. Treat the relay as the network policy boundary. Its DNS resolution,
   redirect handling, private-network restrictions, and upstream response
   limits are operational requirements of the configured relay.

## Consequences

- The Worker no longer has a direct outbound path from user-controlled URLs,
  removing the DNS-rebinding exposure from this component.
- Web extraction depends on Tavily relay availability and configuration; there
  is no local content fallback.
- API clients must handle `failed_results` and the two stable failure codes.
- Relay configuration and monitoring become part of the production web
  extraction dependency rather than an optional quality enhancement.

# Walrus Infra

Pacific writes from the browser through the official Walrus upload relay and serves reads through the app API cache/gateway.

## Files

- `relay.env.example`: relay and cache-facing environment defaults
- `gateway.cache.json`: cache policy for manifest and avatar reads

## Production notes

- Writes: browser -> Walrus upload relay
- Reads: browser -> `apps/api` HTTP gateway -> Walrus SDK on cache miss
- Treat blobs as public unless you encrypt before upload

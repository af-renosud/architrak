# ArchiDoc integration — live client-link lookup

ArchiTrak exposes a server-to-server endpoint so ArchiDoc can render a
"View your quotations & invoices" button that always points at the
*current* live project client link. Never cache the link long-term or
paste it statically — it changes when the architect rotates it.

## Endpoint

```
GET {ARCHITRAK_BASE_URL}/integrations/archidoc/projects/{archidocProjectId}/client-share-link
```

- `archidocProjectId` — ArchiDoc's own project id (the same id ArchiTrak
  stores for project correlation).
- Call from ArchiDoc's **backend only**. Never call from the browser and
  never expose the shared secret client-side.

## Authentication (HMAC, not bearer)

Sign every request with the shared secret (the value ArchiTrak knows as
`ARCHIDOC_WEBHOOK_SECRET`; same secret on both sides):

```
stringToSign = `${timestampMs}.${METHOD}.${path}`
signature    = hex(HMAC-SHA256(secret, stringToSign))
```

- `timestampMs` — current epoch milliseconds.
- `METHOD` — uppercase HTTP method (`GET`).
- `path` — the URL path only, no query string, e.g.
  `/integrations/archidoc/projects/abc-123/client-share-link`.

Headers:

```
X-Archidoc-Timestamp: <timestampMs>
X-Archidoc-Signature: sha256=<lowercase hex signature>
```

Requests with a timestamp more than ±5 minutes from ArchiTrak's clock are
rejected with 401. A missing/incorrect signature is 401. 503 means the
secret is not configured on the ArchiTrak side.

### Node.js example

```js
import { createHmac } from "crypto";

async function fetchClientLink(baseUrl, secret, archidocProjectId) {
  const path = `/integrations/archidoc/projects/${encodeURIComponent(archidocProjectId)}/client-share-link`;
  const ts = Date.now();
  const sig = createHmac("sha256", secret).update(`${ts}.GET.${path}`).digest("hex");
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      "X-Archidoc-Timestamp": String(ts),
      "X-Archidoc-Signature": `sha256=${sig}`,
    },
  });
  return res.json();
}
```

## Response

Every well-formed, authenticated request returns **200** (even when no
link is available — see the reasons below). A malformed project id
(empty or longer than 255 characters) returns 400.

Live link available:

```json
{
  "shareUrl": "https://…/p/client/project/<token>",
  "recipientEmail": "client@example.com",
  "expiresAt": "2026-11-08T15:19:00.000Z"
}
```

No link to show (hide the button — do not show an error to the client):

```json
{ "shareUrl": null, "reason": "no_active_link" }
```

Reasons:

| reason | meaning |
|---|---|
| `unknown_project` | ArchiTrak doesn't track this ArchiDoc project |
| `no_active_link` | No client link has been issued (or it was revoked) |
| `expired` | The link exists but has expired |
| `rotate_required` | Link predates the copy feature — the architect must rotate it once in ArchiTrak |

## Required UX rules on the ArchiDoc side

1. Fetch at page render, or cache for **at most 5 minutes**.
2. Show the button **only** when `shareUrl` is non-null **and**
   `recipientEmail` matches the client viewing the ArchiDoc share. The
   link is a bearer capability — it must never appear on any page other
   clients or contractors can see.
3. On any `null` reason, hide the button entirely.
4. Open the link in a new tab. Do **not** iframe the portal.
5. Lookups are read-only on ArchiTrak's side (they never extend, rotate,
   or count as client activity), so polling within the cache rules is safe.

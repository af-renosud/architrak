# Gmail credential logging: response and recovery

## Assessment

The refreshed-token persistence catch previously printed a raw database
exception. Query parameters in such exceptions can contain the new access
token and, if Google rotated it, a refresh token. The OAuth callback can
similarly contain access/refresh tokens or an authorization code. Google API
exceptions can also contain Authorization headers and token-refresh requests.
Treat credentials in retained historical logs as exposed; this code change
does not erase old logs or revoke credentials.

No exposed value was copied into fixtures or this document. No credentials
were fetched, rotated, revoked, or reconnected during remediation. The exact
historical exposure window and readers of those logs are not established by
the code audit. Do not export raw logs to establish them.

## Owner-approved recovery

The code audit covers per-user token persistence, OAuth callbacks, inbox polling,
reply scans, email-sender logging, payment/design and outstanding-fee schedulers,
operator alerts, the Pennylane email-send queue, the signed-copy sweep catch,
and the shared HTTP/database error loggers. Direct send callers were traced to
their outer catches, not just the immediate Gmail catch. Broader non-Gmail
background-job logging remains separate hardening work.

1. Publish the logging fix before reconnecting, so newly issued credentials
   cannot enter the same unsafe log paths.
2. For affected **per-user inbox grants**, the user should revoke the app's
   Google access in their Google account's third-party connections controls,
   then use the app's **Link my inbox** action (`/api/auth/link-gmail`). This
   forces Google consent and stores the fresh grant. Re-consent alone is not
   proof that an old token has been revoked. Revocation interrupts inbox
   polling and may interrupt sending as that user until reconnection.
3. This grant is distinct from the Replit-managed Gmail connector. Do not
   reconnect a working connector merely because an app-owned grant leaked.
   If the connector is affected, use the supported integration inventory and
   authorization-recovery flow: inspect reauthorization context for the
   existing connection and request reconnect only when indicated. Never
   retrieve tokens or install a duplicate connector.
4. If evidence shows a Google client secret or database connection credential
   was exposed, the owner must approve provider-side rotation. Supply any
   replacement third-party secret through Replit Secrets, never chat, source,
   logs, or shell commands. For Replit-managed database credentials, use the
   supported database/platform controls rather than overwriting runtime-managed
   environment variables. Merely deleting a secret does not revoke it.
5. Verify recovery using authentication/poll success and safe diagnostic
   categories, not printed token values. Review log access for the affected
   interval without copying raw payloads.

## Historical logs

Replit's published-app Monitoring documentation reports **30 days** of log
retention. Filtering or hiding a line does not delete it. No selective purge
control was established by the documentation consulted; do not claim existing
logs were erased. Restrict access using existing workspace access controls and
ask Replit support about early removal of sensitive historical logs if needed.
Apply any independently configured external log-sink retention controls too.
Keep incident records to timestamps, diagnostic categories, and scope, never
credential values. Code remediation does not substitute for revocation.

Sources consulted:
- https://docs.replit.com/features/publishing/monitoring-a-deployment
- https://docs.replit.com/core-concepts/project-editor/app-setup/secrets
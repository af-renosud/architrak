import { google } from 'googleapis';
import { env } from '../env';

let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }

  const hostname = env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = env.REPL_IDENTITY
    ? 'repl ' + env.REPL_IDENTITY
    : env.WEB_REPL_RENEWAL
    ? 'depl ' + env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) {
    throw new Error('X-Replit-Token not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
    {
      headers: {
        'Accept': 'application/json',
        'X-Replit-Token': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Gmail not connected');
  }
  return accessToken;
}

function isFakeGmailEnabled(): boolean {
  return env.NODE_ENV !== 'production' && !!env.E2E_FAKE_GMAIL;
}

/** Public re-export so server/gmail/monitor.ts can branch on fake mode without
 * having to know about the env-var detection logic. */
export function isFakeGmailMode(): boolean {
  return isFakeGmailEnabled();
}

let fakeCounter = 0;
function buildFakeGmailClient() {
  // The fake client used to stub only `messages.send` (E2E send tests).
  // The 15-min inbox poller calls `messages.list` / `labels.list` /
  // `messages.get` / `messages.attachments.get` / `messages.modify` on
  // every tick — those would crash with "undefined is not a function" and
  // park the dashboard's status at `lastPollStatus="error"`. Stub them all
  // as no-ops returning empty result sets so dev polling is silently happy.
  return {
    users: {
      messages: {
        send: async (_args: unknown) => {
          fakeCounter += 1;
          return {
            data: {
              id: `fake-msg-${fakeCounter}`,
              threadId: `fake-thread-${fakeCounter}`,
            },
          };
        },
        list: async (_args: unknown) => ({ data: { messages: [] } }),
        get: async (_args: unknown) => ({ data: { payload: { headers: [], parts: [] }, threadId: "" } }),
        modify: async (_args: unknown) => ({ data: {} }),
        attachments: {
          get: async (_args: unknown) => ({ data: { data: "" } }),
        },
      },
      labels: {
        list: async (_args: unknown) => ({ data: { labels: [] } }),
        create: async (_args: unknown) => ({ data: { id: "fake-label-id" } }),
      },
    },
  } as unknown as ReturnType<typeof google.gmail>;
}

export async function getUncachableGmailClient() {
  if (isFakeGmailEnabled()) {
    return buildFakeGmailClient();
  }
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export function isGmailConfigured(): boolean {
  if (isFakeGmailEnabled()) return true;
  return !!(env.REPLIT_CONNECTORS_HOSTNAME && (env.REPL_IDENTITY || env.WEB_REPL_RENEWAL));
}

import type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelPlugin,
  ChannelStatusIssue,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { buildChannelConfigSchema, formatTextWithAttachmentLinks } from "openclaw/plugin-sdk";
import { AgentChannelClient } from "./client.js";
import { AgentChannelConfigSchema } from "./config-schema.js";
import type { AgentChannelAccountConfig, ResolvedAgentChannelAccount } from "./config.js";
import {
  DEFAULT_ACCOUNT_ID,
  getAccountConfig,
  listAccountIds,
  resolveAgentChannelAccount,
} from "./config.js";
import { monitorAgentChannelProvider } from "./monitor.js";
import { deleteAgentChannelClient, getAgentChannelClient } from "./runtime.js";

const CHANNEL_ID = "agent_channel" as const;

function applyAccountDefaults(
  account: ResolvedAgentChannelAccount | AgentChannelAccountConfig,
): ResolvedAgentChannelAccount {
  const normalizedHost = account.host?.trim() || "127.0.0.1";
  const normalizedPort = account.port ?? 9009;
  return {
    accountId: "accountId" in account ? account.accountId : DEFAULT_ACCOUNT_ID,
    ...account,
    host: normalizedHost,
    port: normalizedPort,
    outboundAuthor: account.outboundAuthor?.trim() || "openclaw",
    allowFrom: Array.isArray(account.allowFrom) ? account.allowFrom : [],
    ignoreAuthors: Array.isArray(account.ignoreAuthors) ? account.ignoreAuthors : [],
  };
}

function buildDefaultAccount(accountId: string): ResolvedAgentChannelAccount {
  return {
    accountId,
    host: "127.0.0.1",
    port: 9009,
    enabled: false,
    outboundAuthor: "openclaw",
    allowFrom: [],
    ignoreAuthors: [],
    token: "",
    signatureSecret: "",
  } satisfies ResolvedAgentChannelAccount;
}

function resolveOutboundAuthor(account: AgentChannelAccountConfig | undefined): string {
  return account?.outboundAuthor?.trim() || "openclaw";
}

function resolveConnectionTarget(account: AgentChannelAccountConfig | undefined): {
  host: string;
  port: number;
} {
  return {
    host: account?.host?.trim() || "127.0.0.1",
    port: account?.port ?? 9009,
  };
}

async function sendTextViaEphemeralClient(params: {
  cfg?: OpenClawConfig;
  account: AgentChannelAccountConfig | undefined;
  accountId: string;
  channelId: string;
  text: string;
}): Promise<void> {
  const { host, port } = resolveConnectionTarget(params.account);
  const client = new AgentChannelClient({ host, port });
  try {
    await client.connect();
    await client.auth({
      token: params.account?.token,
      signatureSecret: params.account?.signatureSecret,
    });
    await client.postMessage({
      channelId: params.channelId,
      content: params.text,
      author: resolveOutboundAuthor(params.account),
    });
  } finally {
    client.close();
  }
}

export const agentChannelPlugin: ChannelPlugin<AgentChannelAccountConfig> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "agent_channel",
    selectionLabel: "agent_channel (TCP)",
    docsPath: "/channels/agent_channel",
    blurb: "agent_channel integration",
    aliases: ["agent-channel", "agentchannel"],
  } satisfies ChannelMeta,
  capabilities: {
    chatTypes: ["channel"],
    media: true,
  } satisfies ChannelCapabilities,
  configSchema: buildChannelConfigSchema(AgentChannelConfigSchema),
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => listAccountIds(cfg),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): AgentChannelAccountConfig => {
      const resolvedId = (accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
      const resolved = resolveAgentChannelAccount({ cfg, accountId: resolvedId });
      const config = getAccountConfig(cfg, resolvedId);
      if (!config) {
        return buildDefaultAccount(resolvedId);
      }
      return applyAccountDefaults(resolved);
    },
    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: unknown): boolean => {
      const record = account as Partial<AgentChannelAccountConfig> | undefined;
      const host = typeof record?.host === "string" ? record.host.trim() : "";
      const port = typeof record?.port === "number" ? record.port : undefined;
      return Boolean(host) && typeof port === "number" && Number.isFinite(port) && port > 0;
    },
    isEnabled: (account: AgentChannelAccountConfig | undefined): boolean =>
      account?.enabled !== false,
    describeAccount: (account: AgentChannelAccountConfig | undefined) => {
      const enabled = account?.enabled !== false;
      const configured = Boolean(account?.host?.trim()) && typeof account?.port === "number";
      const accountId =
        account &&
        typeof account === "object" &&
        "accountId" in account &&
        typeof account.accountId === "string"
          ? account.accountId
          : DEFAULT_ACCOUNT_ID;
      const name =
        account &&
        typeof account === "object" &&
        "name" in account &&
        typeof account.name === "string"
          ? account.name
          : undefined;
      return { accountId, name, enabled, configured, host: account?.host, port: account?.port };
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const channelId = (ctx.to ?? "").trim();
      if (!channelId) {
        throw new Error("agent_channel outbound requires to=<channel_id>");
      }
      const accountId = (ctx.accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
      const account = resolveAgentChannelAccount({ cfg: ctx.cfg as OpenClawConfig, accountId });
      const client = getAgentChannelClient(accountId);

      const combined = ctx.text?.trim() ?? "";
      if (!combined) {
        return { channel: CHANNEL_ID, messageId: "" };
      }

      if (client && client.isConnected()) {
        await client.postMessage({
          channelId,
          content: combined,
          author: resolveOutboundAuthor(account),
        });
        return { channel: CHANNEL_ID, messageId: "" };
      }

      await sendTextViaEphemeralClient({
        cfg: ctx.cfg as OpenClawConfig,
        account,
        accountId,
        channelId,
        text: combined,
      });
      return { channel: CHANNEL_ID, messageId: "" };
    },
    sendMedia: async (ctx) => {
      const channelId = (ctx.to ?? "").trim();
      if (!channelId) {
        throw new Error("agent_channel outbound requires to=<channel_id>");
      }
      const accountId = (ctx.accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
      const account = resolveAgentChannelAccount({ cfg: ctx.cfg as OpenClawConfig, accountId });
      const client = getAgentChannelClient(accountId);

      const combined = formatTextWithAttachmentLinks(ctx.text, ctx.mediaUrl ? [ctx.mediaUrl] : []);
      if (!combined) {
        return { channel: CHANNEL_ID, messageId: "" };
      }

      if (client && client.isConnected()) {
        await client.postMessage({
          channelId,
          content: combined,
          author: resolveOutboundAuthor(account),
        });
        return { channel: CHANNEL_ID, messageId: "" };
      }

      await sendTextViaEphemeralClient({
        cfg: ctx.cfg as OpenClawConfig,
        account,
        accountId,
        channelId,
        text: combined,
      });
      return { channel: CHANNEL_ID, messageId: "" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    } satisfies ChannelAccountSnapshot,
    buildAccountSnapshot: ({ account, runtime }) => {
      return {
        accountId:
          account &&
          typeof account === "object" &&
          "accountId" in account &&
          typeof account.accountId === "string"
            ? account.accountId
            : DEFAULT_ACCOUNT_ID,
        enabled: account?.enabled !== false,
        configured: Boolean(account?.host && account?.port),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        host: account?.host,
        port: account?.port,
        outboundAuthor: account?.outboundAuthor,
        allowFrom: account?.allowFrom,
        ignoreAuthors: account?.ignoreAuthors,
      };
    },
    collectStatusIssues: (accounts): ChannelStatusIssue[] => {
      const issues: ChannelStatusIssue[] = [];
      for (const acc of accounts) {
        if (!acc.configured) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: acc.accountId,
            kind: "config",
            message: "agent_channel is not configured (host/port missing)",
            fix: "Set channels.agent_channel.host and channels.agent_channel.port (or channels.agent_channel.accounts.<id>)",
          });
        }
      }
      return issues;
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      await monitorAgentChannelProvider({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        account: ctx.account,
        gatewayCtx: ctx,
      });
      return undefined;
    },
    stopAccount: async (ctx) => {
      deleteAgentChannelClient(ctx.accountId);
    },
  },
};

import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  OutboundReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  dispatchInboundReplyWithBase,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "openclaw/plugin-sdk";
import type { FinalizedMsgContext } from "../../../src/auto-reply/templating.js";
import { AgentChannelClient } from "./client.js";
import type { AgentChannelAccountConfig, ResolvedAgentChannelAccount } from "./config.js";
import { deleteAgentChannelClient, setAgentChannelClient } from "./runtime.js";

const CHANNEL_ID = "agent_channel" as const;

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

function resolveMessagePostedPayload(event: unknown): {
  channelId: string;
  content: string;
  author: string;
  timestamp?: number;
  messageId?: string;
} | null {
  const record = event as Record<string, unknown>;
  const name = normalizeToken(record.name ?? record.event ?? record.type);
  if (name !== "message.posted") {
    return null;
  }
  const payload = (record.payload ?? record.data ?? record.message ?? record.msg ?? record) as
    | Record<string, unknown>
    | undefined;
  const channelId =
    toStringValue(payload?.channel_id) ||
    toStringValue(payload?.channelId) ||
    toStringValue(record.channel_id) ||
    toStringValue(record.channelId);
  const content =
    toStringValue(payload?.content) ||
    toStringValue(payload?.body) ||
    toStringValue(payload?.text) ||
    toStringValue(record.content) ||
    toStringValue(record.body) ||
    toStringValue(record.text);
  const author =
    toStringValue(payload?.author) ||
    toStringValue(payload?.from) ||
    toStringValue(payload?.sender) ||
    toStringValue(record.author) ||
    toStringValue(record.from) ||
    toStringValue(record.sender) ||
    "user";
  const timestampRaw = payload?.timestamp ?? payload?.ts ?? record.timestamp ?? record.ts;
  const timestamp = typeof timestampRaw === "number" ? timestampRaw : undefined;
  const messageId = toStringValue(payload?.id ?? payload?.message_id ?? payload?.messageId);
  if (!channelId || !content) {
    return null;
  }
  return { channelId, content, author, timestamp, messageId: messageId || undefined };
}

function isSenderAllowed(account: AgentChannelAccountConfig | undefined, author: string): boolean {
  const allowFrom = account?.allowFrom ?? [];
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
    return true;
  }
  const normalized = author.trim().toLowerCase();
  return allowFrom.some((entry) => entry.trim().toLowerCase() === normalized);
}

function shouldIgnoreAuthor(
  account: AgentChannelAccountConfig | undefined,
  author: string,
): boolean {
  const ignore = account?.ignoreAuthors ?? [];
  const normalized = author.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (Array.isArray(ignore) && ignore.some((entry) => entry.trim().toLowerCase() === normalized)) {
    return true;
  }
  const outboundAuthor = normalizeToken(account?.outboundAuthor) || "openclaw";
  return outboundAuthor === normalized;
}

async function deliverAgentChannelReply(params: {
  client: AgentChannelClient;
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  payload: OutboundReplyPayload;
  outboundAuthor: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!combined) {
    return;
  }
  await params.client.postMessage({
    channelId: params.channelId,
    content: combined,
    author: params.outboundAuthor,
  });
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function monitorAgentChannelProvider(params: {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAgentChannelAccount | AgentChannelAccountConfig;
  gatewayCtx: ChannelGatewayContext<AgentChannelAccountConfig>;
}): Promise<void> {
  const host = params.account.host?.trim() || "127.0.0.1";
  const port = params.account.port ?? 9009;
  const outboundAuthor = params.account.outboundAuthor?.trim() || "openclaw";
  const client = new AgentChannelClient({
    host,
    port,
    abortSignal: params.gatewayCtx.abortSignal,
  });
  setAgentChannelClient(params.accountId, client);

  const setStatus = (patch: Partial<ChannelAccountSnapshot>) => {
    const next = { ...params.gatewayCtx.getStatus(), ...patch };
    params.gatewayCtx.setStatus(next);
  };

  const log = params.gatewayCtx.runtime.log;
  const error = params.gatewayCtx.runtime.error;

  try {
    setStatus({ running: true, lastStartAt: Date.now(), lastError: null });
    await client.connect();
    await client.auth({
      token: params.account.token,
      signatureSecret: params.account.signatureSecret,
    });
    await client.subscribeEvents();

    const onEvent = async (event: unknown) => {
      const payload = resolveMessagePostedPayload(event);
      if (!payload) {
        return;
      }
      setStatus({ lastInboundAt: payload.timestamp ?? Date.now() });

      if (!isSenderAllowed(params.account, payload.author)) {
        return;
      }
      if (shouldIgnoreAuthor(params.account, payload.author)) {
        return;
      }

      const channelRuntime = params.gatewayCtx.channelRuntime;
      if (!channelRuntime) {
        return;
      }

      const route = channelRuntime.routing.resolveAgentRoute({
        cfg: params.cfg,
        channel: CHANNEL_ID,
        accountId: params.accountId,
        peer: { kind: "channel", id: payload.channelId },
      });

      const storePath = channelRuntime.session.resolveStorePath(params.cfg.session?.store, {
        agentId: route.agentId,
      });

      const ctxPayload = channelRuntime.reply.finalizeInboundContext({
        Body: payload.content,
        RawBody: payload.content,
        CommandBody: payload.content,
        BodyForAgent: payload.content,
        BodyForCommands: payload.content,
        From: payload.author,
        To: payload.channelId,
        AccountId: params.accountId,
        SessionKey: route.sessionKey,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        ChatType: "channel",
        ConversationLabel: `#${payload.channelId}`,
        SenderName: payload.author,
        SenderId: payload.author,
        Timestamp: payload.timestamp ?? Date.now(),
        MessageSid: payload.messageId,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: payload.channelId,
        ExplicitDeliverRoute: true,
        CommandAuthorized: true,
      }) as FinalizedMsgContext;

      await dispatchInboundReplyWithBase({
        cfg: params.cfg,
        channel: CHANNEL_ID,
        accountId: params.accountId,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        storePath,
        ctxPayload,
        core: {
          channel: {
            session: { recordInboundSession: channelRuntime.session.recordInboundSession },
            reply: {
              dispatchReplyWithBufferedBlockDispatcher:
                channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
            },
          },
        },
        deliver: async (replyPayload) => {
          await deliverAgentChannelReply({
            client,
            cfg: params.cfg,
            accountId: params.accountId,
            channelId: payload.channelId,
            payload: replyPayload,
            outboundAuthor,
            statusSink: (patch) => setStatus(patch),
          });
        },
        onRecordError: (err) => {
          error?.(String(err));
        },
        onDispatchError: (err) => {
          error?.(String(err));
        },
      });
    };

    client.on("event", (event) => {
      void onEvent(event).catch((err) => {
        error?.(String(err));
      });
    });

    await new Promise<void>((resolve) => {
      params.gatewayCtx.abortSignal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`${CHANNEL_ID}: provider error: ${message}`);
    setStatus({ running: false, lastError: message, lastStopAt: Date.now() });
    throw err;
  } finally {
    deleteAgentChannelClient(params.accountId);
    setStatus({ running: false, lastStopAt: Date.now() });
  }
}

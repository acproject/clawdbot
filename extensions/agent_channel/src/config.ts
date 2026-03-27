import type { OpenClawConfig } from "openclaw/plugin-sdk";

export const DEFAULT_ACCOUNT_ID = "default";

export type AgentChannelAccountConfig = {
  host?: string;
  port?: number;
  token?: string;
  signatureSecret?: string;
  enabled?: boolean;
  allowFrom?: string[];
  ignoreAuthors?: string[];
  outboundAuthor?: string;
};

export type ResolvedAgentChannelAccount = {
  accountId: string;
  name?: string;
} & AgentChannelAccountConfig;

type AgentChannelSection = {
  name?: string;
  enabled?: boolean;
  accounts?: Record<string, AgentChannelAccountConfig>;
} & AgentChannelAccountConfig;

function getSection(cfg: OpenClawConfig): AgentChannelSection | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.agent_channel as
    | AgentChannelSection
    | undefined;
}

function isMultiAccount(
  section: AgentChannelSection | undefined,
): section is AgentChannelSection & {
  accounts: Record<string, AgentChannelAccountConfig>;
} {
  return Boolean(section && section.accounts && typeof section.accounts === "object");
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  const section = getSection(cfg);
  if (!section) {
    return [];
  }
  const ids: string[] = [];
  const hasBaseLevelConfig =
    typeof section.host === "string" ||
    typeof section.port === "number" ||
    typeof section.token === "string" ||
    typeof section.signatureSecret === "string" ||
    typeof section.enabled === "boolean" ||
    typeof section.outboundAuthor === "string" ||
    Array.isArray(section.allowFrom) ||
    Array.isArray(section.ignoreAuthors);

  if (isMultiAccount(section)) {
    ids.push(...Object.keys(section.accounts || {}));
    if (hasBaseLevelConfig && !ids.includes(DEFAULT_ACCOUNT_ID)) {
      ids.push(DEFAULT_ACCOUNT_ID);
    }
    return ids;
  }

  return hasBaseLevelConfig ? [DEFAULT_ACCOUNT_ID] : [];
}

export function getAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): AgentChannelAccountConfig | undefined {
  const section = getSection(cfg);
  if (!section) {
    return undefined;
  }
  const baseLevel: AgentChannelAccountConfig = {
    host: section.host,
    port: section.port,
    token: section.token,
    signatureSecret: section.signatureSecret,
    enabled: section.enabled,
    allowFrom: section.allowFrom,
    ignoreAuthors: section.ignoreAuthors,
    outboundAuthor: section.outboundAuthor,
  };
  if (isMultiAccount(section)) {
    const fromAccounts = section.accounts[accountId];
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      return fromAccounts;
    }
    return {
      ...(fromAccounts ?? {}),
      ...baseLevel,
    };
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return undefined;
  }
  return baseLevel;
}

export function resolveAgentChannelAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedAgentChannelAccount {
  const resolvedId = (params.accountId ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
  const section = getSection(params.cfg);
  const config = getAccountConfig(params.cfg, resolvedId) ?? {};
  const enabled =
    typeof config.enabled === "boolean"
      ? config.enabled
      : typeof section?.enabled === "boolean"
        ? section.enabled
        : true;
  const name = resolvedId === DEFAULT_ACCOUNT_ID ? section?.name : undefined;
  return {
    accountId: resolvedId,
    name,
    ...config,
    enabled,
  };
}

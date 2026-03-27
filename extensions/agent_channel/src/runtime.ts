import { AgentChannelClient } from "./client.js";

const clientsByAccountId = new Map<string, AgentChannelClient>();

export function getAgentChannelClient(accountId: string): AgentChannelClient | undefined {
  return clientsByAccountId.get(accountId);
}

export function setAgentChannelClient(accountId: string, client: AgentChannelClient): void {
  clientsByAccountId.set(accountId, client);
}

export function deleteAgentChannelClient(accountId: string): void {
  const existing = clientsByAccountId.get(accountId);
  if (existing) {
    existing.close();
  }
  clientsByAccountId.delete(accountId);
}

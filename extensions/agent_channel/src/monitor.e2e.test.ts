import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher as actualDispatchReplyWithBufferedBlockDispatcher } from "../../../src/auto-reply/reply/provider-dispatcher.js";
import { recordInboundSession as actualRecordInboundSession } from "../../../src/channels/session.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { AgentChannelClient } from "./client.js";
import { monitorAgentChannelProvider } from "./monitor.js";
import { getAgentChannelClient } from "./runtime.js";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFilePath);
const cppProjectRoot = path.resolve(thisDir, "../../../../../cpp_projects/agent_channel");
const miniMemoryBinaryPath = path.join(cppProjectRoot, "build", "bin", "mini_cache_server");
const channelDaemonBinaryPath = path.join(cppProjectRoot, "build", "channel_daemon");
const sharedLibraryDir = path.join(cppProjectRoot, "build", "lib");
const binariesReady =
  process.platform !== "win32" &&
  existsSync(miniMemoryBinaryPath) &&
  existsSync(channelDaemonBinaryPath);

type ManagedProcess = {
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate local port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForPort(params: {
  host: string;
  port: number;
  timeoutMs: number;
  process?: ManagedProcess;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const managedProcess = params.process;
    if (managedProcess && managedProcess.child.exitCode !== null) {
      throw new Error(
        [
          `process exited before port ${params.port} became ready`,
          managedProcess.stdout.join(""),
          managedProcess.stderr.join(""),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: params.host, port: params.port });
      const settle = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
    if (connected) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${params.host}:${params.port}`);
}

function startProcess(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ManagedProcess {
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, stdout, stderr };
}

async function stopProcess(process: ManagedProcess | undefined): Promise<void> {
  if (!process || process.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      process.child.kill("SIGKILL");
    }, 3000);
    process.child.once("close", () => {
      clearTimeout(timer);
      finish();
    });
    process.child.kill("SIGTERM");
  });
}

async function createSubscribedClient(port: number): Promise<AgentChannelClient> {
  const client = new AgentChannelClient({ host: "127.0.0.1", port, connectTimeoutMs: 5000 });
  await client.connect();
  await client.subscribeEvents(5000);
  return client;
}

function resolveMessagePostedEvent(
  event: unknown,
): { channelId: string; author: string; content: string } | null {
  const record = event as Record<string, unknown>;
  if (record.type !== "message.posted") {
    return null;
  }
  const message = (record.message ?? {}) as Record<string, unknown>;
  const channelId =
    (typeof record.channel_id === "string" ? record.channel_id : undefined) ??
    (typeof message.channel_id === "string" ? message.channel_id : undefined);
  const author = typeof message.author === "string" ? message.author : "";
  const content = typeof message.content === "string" ? message.content : "";
  if (!channelId || !author || !content) {
    return null;
  }
  return { channelId, author, content };
}

async function waitForEvent<T>(params: {
  client: AgentChannelClient;
  timeoutMs: number;
  match: (event: unknown) => T | null;
}): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      params.client.off("event", onEvent);
      reject(new Error(`timed out waiting for matching event after ${params.timeoutMs}ms`));
    }, params.timeoutMs);
    const onEvent = (event: unknown) => {
      const matched = params.match(event);
      if (!matched) {
        return;
      }
      clearTimeout(timer);
      params.client.off("event", onEvent);
      resolve(matched);
    };
    params.client.on("event", onEvent);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!binariesReady)("monitorAgentChannelProvider e2e", () => {
  it("subscribes to channel_daemon events and posts the generated reply back through message.post", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-channel-e2e-"));
    const miniMemoryPort = await allocatePort();
    const channelDaemonPort = await allocatePort();
    const miniMemoryConfigPath = path.join(tempRoot, "minimemory.conf");
    const channelDaemonConfigPath = path.join(tempRoot, "channel-daemon.json");
    const sessionStorePath = path.join(tempRoot, "sessions.json");
    const outboundText = "agent_channel e2e reply";
    const inboundAuthor = "alice";
    const outboundAuthor = "openclaw-e2e";
    const channelId = "agent-channel-e2e-room";
    const accountId = "default";
    let miniMemoryProcess: ManagedProcess | undefined;
    let channelDaemonProcess: ManagedProcess | undefined;
    let observerClient: AgentChannelClient | undefined;
    let monitorPromise: Promise<void> | undefined;
    const abortController = new AbortController();

    try {
      await fs.writeFile(
        miniMemoryConfigPath,
        [`bind 127.0.0.1`, `port ${miniMemoryPort}`, `appendonly no`].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        channelDaemonConfigPath,
        JSON.stringify(
          {
            daemon: {
              tcp: {
                port: channelDaemonPort,
              },
              minimemory: {
                host: "127.0.0.1",
                port: miniMemoryPort,
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });

      const childEnv = {
        ...process.env,
        LD_LIBRARY_PATH: [sharedLibraryDir, process.env.LD_LIBRARY_PATH ?? ""]
          .filter(Boolean)
          .join(":"),
      };

      miniMemoryProcess = startProcess({
        command: miniMemoryBinaryPath,
        args: ["--config", miniMemoryConfigPath],
        cwd: cppProjectRoot,
        env: childEnv,
      });
      await waitForPort({
        host: "127.0.0.1",
        port: miniMemoryPort,
        timeoutMs: 10000,
        process: miniMemoryProcess,
      });

      channelDaemonProcess = startProcess({
        command: channelDaemonBinaryPath,
        args: ["--config", channelDaemonConfigPath],
        cwd: cppProjectRoot,
        env: childEnv,
      });
      await waitForPort({
        host: "127.0.0.1",
        port: channelDaemonPort,
        timeoutMs: 10000,
        process: channelDaemonProcess,
      });

      observerClient = await createSubscribedClient(channelDaemonPort);
      await observerClient.request({
        method: "channel.create",
        params: {
          id: channelId,
          name: "Agent Channel E2E",
        },
        timeoutMs: 5000,
      });

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {},
        },
        channels: {
          agent_channel: {
            host: "127.0.0.1",
            port: channelDaemonPort,
            allowFrom: [inboundAuthor],
            outboundAuthor,
          },
        },
      };

      let status: Record<string, unknown> = {};
      const resolveAgentRoute = vi.fn(() => ({
        agentId: "default",
        sessionKey: `agent:default:agent_channel:channel:${channelId}`,
      }));
      const recordInboundSession = vi.fn(
        async (params: Parameters<typeof actualRecordInboundSession>[0]) => {
          await actualRecordInboundSession(params);
        },
      );
      const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
        async (params: Parameters<typeof actualDispatchReplyWithBufferedBlockDispatcher>[0]) => {
          return await actualDispatchReplyWithBufferedBlockDispatcher({
            ...params,
            replyResolver: async () => ({
              text: outboundText,
            }),
          });
        },
      );

      monitorPromise = monitorAgentChannelProvider({
        cfg,
        accountId,
        account: {
          accountId,
          host: "127.0.0.1",
          port: channelDaemonPort,
          allowFrom: [inboundAuthor],
          outboundAuthor,
          enabled: true,
        },
        gatewayCtx: {
          abortSignal: abortController.signal,
          runtime: {
            log: vi.fn(),
            error: vi.fn(),
          },
          getStatus: () => status,
          setStatus: (next: unknown) => {
            status = next as Record<string, unknown>;
          },
          channelRuntime: {
            routing: {
              resolveAgentRoute,
            },
            session: {
              resolveStorePath: vi.fn(() => sessionStorePath),
              recordInboundSession,
            },
            reply: {
              finalizeInboundContext,
              dispatchReplyWithBufferedBlockDispatcher,
            },
          },
        } as never,
      });

      await vi.waitFor(() => {
        const client = getAgentChannelClient(accountId);
        expect(client?.isConnected()).toBe(true);
        expect(client?.listenerCount("event")).toBeGreaterThan(0);
      });

      const outboundEventPromise = waitForEvent({
        client: observerClient,
        timeoutMs: 15000,
        match: (event) => {
          const payload = resolveMessagePostedEvent(event);
          if (!payload) {
            return null;
          }
          if (payload.channelId !== channelId || payload.author !== outboundAuthor) {
            return null;
          }
          return payload;
        },
      });

      await observerClient.postMessage({
        channelId,
        content: "hello from channel_daemon",
        author: inboundAuthor,
        timeoutMs: 5000,
      });

      const outboundEvent = await outboundEventPromise;
      await vi.waitFor(async () => {
        const sessionStoreText = await fs.readFile(sessionStorePath, "utf8");
        expect(sessionStoreText).toContain(`agent:default:agent_channel:channel:${channelId}`);
      });

      const recordedInbound = recordInboundSession.mock.calls[0]?.[0];
      const dispatchedInbound = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];

      expect(outboundEvent).toEqual({
        channelId,
        author: outboundAuthor,
        content: outboundText,
      });
      expect(resolveAgentRoute).toHaveBeenCalledWith({
        cfg,
        channel: "agent_channel",
        accountId,
        peer: { kind: "channel", id: channelId },
      });
      expect(recordInboundSession).toHaveBeenCalledTimes(1);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      expect(recordedInbound?.ctx.Body).toBe("hello from channel_daemon");
      expect(recordedInbound?.ctx.From).toBe(inboundAuthor);
      expect(dispatchedInbound?.ctx.Body).toBe("hello from channel_daemon");
      expect(dispatchedInbound?.ctx.OriginatingTo).toBe(channelId);
      expect(status.lastInboundAt).toEqual(expect.any(Number));
      expect(status.lastOutboundAt).toEqual(expect.any(Number));
    } finally {
      abortController.abort();
      await monitorPromise?.catch(() => undefined);
      observerClient?.close();
      await stopProcess(channelDaemonProcess);
      await stopProcess(miniMemoryProcess);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 60000);
});

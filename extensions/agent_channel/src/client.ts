import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

export type AgentChannelRpcOk = { id: number; ok: true; result?: unknown };
export type AgentChannelRpcErr = { id: number; ok: false; error?: unknown };
export type AgentChannelEventLine = { type: "event"; event: unknown };
export type AgentChannelLine = AgentChannelRpcOk | AgentChannelRpcErr | AgentChannelEventLine;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (typeof err === "string") {
    return new Error(err);
  }
  return new Error(JSON.stringify(err));
}

function normalizeToken(value: string | undefined): string {
  return (value ?? "").trim();
}

function nowMs(): number {
  return Date.now();
}

export function computeTcpAuthSig(params: {
  signatureSecret: string;
  tsMs: number;
  token: string;
}): string {
  const secret = normalizeToken(params.signatureSecret);
  const token = normalizeToken(params.token);
  const payload = `${secret}|${params.tsMs}|${token}`;
  return crypto.createHash("sha1").update(payload, "utf8").digest("hex");
}

export type AgentChannelClientOptions = {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  abortSignal?: AbortSignal;
};

export class AgentChannelClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connected = false;

  constructor(private readonly options: AgentChannelClientOptions) {
    super();
  }

  isConnected() {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    const socket = net.connect({ host: this.options.host, port: this.options.port });
    this.socket = socket;
    socket.setEncoding("utf8");

    const timeoutMs = this.options.connectTimeoutMs ?? 15000;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishOk = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const finishErr = (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(toError(err));
      };

      const timer = setTimeout(
        () => finishErr(new Error(`connect timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );

      socket.once("connect", () => {
        clearTimeout(timer);
        this.connected = true;
        finishOk();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        finishErr(err);
      });
    });

    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        idx = this.buffer.indexOf("\n");
        if (!line) {
          continue;
        }
        this.handleLine(line);
      }
    });

    socket.on("error", (err) => {
      this.failAllPending(err);
      this.emit("error", err);
    });

    socket.on("close", () => {
      this.connected = false;
      this.failAllPending(new Error("socket closed"));
      this.emit("close");
    });

    this.options.abortSignal?.addEventListener(
      "abort",
      () => {
        this.close();
      },
      { once: true },
    );
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    try {
      socket?.destroy();
    } catch {
      // ignore
    }
  }

  private failAllPending(err: unknown) {
    const error = toError(err);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(rawLine: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch {
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "event") {
      this.emit("event", (record as AgentChannelEventLine).event);
      return;
    }
    const id = record.id;
    if (typeof id !== "number") {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.ok === true) {
      pending.resolve(record.result);
      return;
    }
    pending.reject(toError(record.error ?? "request failed"));
  }

  async request(params: {
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    if (!this.socket || !this.connected) {
      throw new Error("not connected");
    }
    const id = this.nextId++;
    const timeoutMs = params.timeoutMs ?? 15000;
    const payload = JSON.stringify({
      id,
      method: params.method,
      params: params.params ?? {},
    });
    const line = `${payload}\n`;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout after ${timeoutMs}ms (${params.method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.write(line, "utf8");
    });
  }

  async auth(params: {
    token?: string;
    signatureSecret?: string;
    timeoutMs?: number;
  }): Promise<void> {
    const token = normalizeToken(params.token);
    const signatureSecret = normalizeToken(params.signatureSecret);
    const needsAuth = Boolean(token || signatureSecret);
    if (!needsAuth) {
      return;
    }
    const tsMs = nowMs();
    const sig = signatureSecret ? computeTcpAuthSig({ signatureSecret, tsMs, token }) : "";
    await this.request({
      method: "auth",
      params: { token, ts: tsMs, sig },
      timeoutMs: params.timeoutMs,
    });
  }

  async subscribeEvents(timeoutMs?: number): Promise<void> {
    await this.request({ method: "event.subscribe", params: {}, timeoutMs });
  }

  async postMessage(params: {
    channelId: string;
    content: string;
    author?: string;
    timeoutMs?: number;
  }): Promise<void> {
    await this.request({
      method: "message.post",
      params: {
        channel_id: params.channelId,
        content: params.content,
        author: params.author,
      },
      timeoutMs: params.timeoutMs,
    });
  }
}

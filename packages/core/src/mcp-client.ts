/**
 * MCP 客户端 — stdio + HTTP transport，工具发现与调用
 *
 * 协议: MCP (Model Context Protocol) JSON-RPC 2.0
 * 参考: https://spec.modelcontextprotocol.io/
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// ---- Types ----

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

// ---- Transport abstraction ----

interface McpTransport {
  send(req: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  close(): void;
}

/** HTTP transport (streamable HTTP POST) */
class HttpTransport implements McpTransport {
  constructor(
    private url: string,
    private headers: Record<string, string>,
  ) {}

  async send(req: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const timeoutSignal = AbortSignal.timeout(30000);
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(req),
      signal: merged,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`MCP HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    return resp.json() as Promise<JsonRpcResponse>;
  }

  close() { /* no-op for HTTP */ }
}

/** stdio transport (subprocess JSON-RPC over stdin/stdout) */
class StdioTransport implements McpTransport {
  private proc: ChildProcess;
  private reqId = 0;
  private pending = new Map<number, {
    resolve: (r: JsonRpcResponse) => void;
    reject: (e: Error) => void;
  }>();

  constructor(command: string, args: string[], env?: Record<string, string>) {
    const isWin = process.platform === 'win32';
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      shell: isWin,          // Windows: resolve .cmd via shell
      windowsHide: true,    // 隐藏控制台窗口
    });

    // Read newline-delimited JSON from stdout
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      try {
        const resp: JsonRpcResponse = JSON.parse(line);
        const pending = this.pending.get(resp.id);
        if (pending) {
          this.pending.delete(resp.id);
          pending.resolve(resp);
        }
      } catch {
        // stderr or non-JSON output — ignore
      }
    });

    // Log stderr
    this.proc.stderr?.on('data', (data: Buffer) => {
      // MCP servers may log to stderr — silently ignore in production
      if (process.env.SHENLAN_DEBUG === '1') {
        process.stderr.write(`[mcp:stderr] ${data.byteLength} bytes received\n`);
      }
    });

    this.proc.on('error', (err) => {
      // 启动失败时 reject 所有 pending 请求
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP process exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  async send(req: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = req.id;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify(req) + '\n');

      // Abort via signal — reject pending and kill process
      if (signal) {
        signal.addEventListener('abort', () => {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            p.reject(new DOMException('Aborted', 'AbortError'));
          }
        }, { once: true });
      }
    });
  }

  close() {
    this.proc.kill();
  }
}

// ---- MCP Client ----

export class McpClient {
  private transport: McpTransport;
  private nextId = 1;
  private _tools: McpToolDef[] = [];
  private _capabilities: string[] = [];
  private _connected = false;

  constructor(private config: McpServerConfig) {
    if (config.transport === 'http') {
      if (!config.url) throw new Error(`MCP server "${config.name}": HTTP transport requires url`);
      // Resolve env:VAR references in headers
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(config.headers || {})) {
        headers[k] = v.startsWith('env:') ? (process.env[v.slice(4)] || '') : v;
      }
      this.transport = new HttpTransport(config.url, headers);
    } else {
      if (!config.command) throw new Error(`MCP server "${config.name}": stdio transport requires command`);
      // 与 HTTP headers 一致：env 值支持 env:VAR 引用，密钥不落配置文件
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(config.env || {})) {
        env[k] = v.startsWith('env:') ? (process.env[v.slice(4)] || '') : v;
      }
      this.transport = new StdioTransport(
        config.command,
        config.args || [],
        env,
      );
    }
  }

  get name() { return this.config.name; }
  get connected() { return this._connected; }
  get tools() { return this._tools; }
  /** initialize 响应里 server 声明的 capabilities（tools/resources/prompts 等） */
  get capabilities() { return this._capabilities; }

  /** 发送 JSON-RPC 请求 */
  private async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    };
    const resp = await this.transport.send(req, signal);
    if (resp.error) {
      throw new Error(`MCP error [${resp.error.code}]: ${resp.error.message}`);
    }
    return resp.result;
  }

  /** 连接到 MCP server 并初始化 */
  async connect(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'shenlan', version: '0.1.0' },
    }) as { serverInfo?: { name: string }; capabilities?: unknown };
    this._connected = true;
    this._capabilities = Object.keys((result.capabilities as Record<string, unknown>) || {});
    if (process.env.SHENLAN_DEBUG === '1') {
      process.stderr.write(`[mcp] Connected to "${this.config.name}" (${result.serverInfo?.name || 'unknown'})\n`);
    }
  }

  /** 列出服务器提供的工具 */
  async listTools(): Promise<McpToolDef[]> {
    const result = await this.request('tools/list') as { tools: McpToolDef[] };
    this._tools = result.tools || [];
    return this._tools;
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    const result = await this.request('tools/call', { name, arguments: args }, signal) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    return result;
  }

  /** 断开连接 */
  close(): void {
    this.transport.close();
    this._connected = false;
  }
}

// ---- 导出类型 ----
export type { McpServerConfig, McpToolDef };

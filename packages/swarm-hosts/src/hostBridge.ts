/**
 * 宿主桥客户端：Electron 主进程与旧蜂群 Python 适配器之间的进程边界。
 *
 * 设计理由：旧蜂群的 adapters.py 已经掌握 CodeBuddy / Antigravity / ZCode / DSH
 * 的登录、模型参数、围栏解析和思考捕获；这些是我们自己的代码，直接复用比重写可靠。
 * 桥只做传输，会话、项目、协作状态一律留在主进程和 SQLite。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface HostRunRequest {
  host: string;
  prompt: string;
  model?: string;
  sessionId?: string | null;
  workspace: string;
  effort?: string;
  timeout?: number;
  accessMode?: string;
  /** 本次 run 的 MCP 工具配置；只有支持 MCP 的宿主会被注入 */
  tools?: { command: string; args: string[]; env: Record<string, string> };
}

export interface HostReply {
  text: string;
  sessionId: string;
  model: string;
  seconds: number;
}

export interface HostEvent {
  runId: string;
  kind: string;
  payload: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const PYTHON_CANDIDATES: string[][] = [
  ...(process.env.SWARM_PYTHON ? [[process.env.SWARM_PYTHON]] : []),
  ['py', '-3'],
  ['python'],
  ['python3'],
];

export class HostBridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private starting?: Promise<void>;
  private pythonArgs: string[] = [];
  private stderrTail: string[] = [];
  private readonly scriptDir: string;

  constructor(scriptDir?: string) {
    super();
    this.scriptDir = scriptDir ?? path.resolve(__dirname, '../../../swarm-hosts/python');
  }

  /** 启动 Python 桥并等到 ready；失败时把候选 Python 的原始错误带出来。 */
  async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async boot(): Promise<void> {
    const script = path.join(this.scriptDir, 'bridge.py');
    if (!existsSync(script)) throw new Error(`找不到宿主桥脚本：${script}`);
    const errors: string[] = [];
    for (const candidate of PYTHON_CANDIDATES) {
      try {
        await this.launch(candidate, script);
        return;
      } catch (error) {
        errors.push(`${candidate.join(' ')} → ${(error as Error).message}`);
        this.child?.kill();
        this.child = undefined;
      }
    }
    throw new Error(`没有可用的 Python 解释器：\n${errors.join('\n')}`);
  }

  private launch(python: string[], script: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(python[0], [...python.slice(1), script], {
        cwd: this.scriptDir,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
        },
        windowsHide: true,
      });
      this.child = child;
      this.pythonArgs = python;
      const timer = setTimeout(() => reject(new Error('宿主桥 15 秒内未就绪')), 15_000);

      readline.createInterface({ input: child.stdout }).on('line', line => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // 宿主自己往 stdout 打印的内容不属于桥协议
        }
        if (message.kind === 'ready') {
          clearTimeout(timer);
          resolve();
          return;
        }
        this.dispatch(message);
      });

      child.stderr.on('data', chunk => {
        const text = chunk.toString();
        this.stderrTail.push(text);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      });
      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', code => {
        clearTimeout(timer);
        for (const [, pending] of this.pending) pending.reject(new Error(`宿主桥已退出（code ${code}）`));
        this.pending.clear();
        this.child = undefined;
        this.emit('bridge-exit', code);
        reject(new Error(`宿主桥已退出（code ${code}）`));
      });
    });
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = typeof message.id === 'string' ? message.id : undefined;
    const kind = message.kind;
    if (kind === 'event' && id) {
      this.emit('event', { runId: id, kind: String(message.event), payload: message.payload } satisfies HostEvent);
      return;
    }
    if (kind === 'result' && id) {
      const reply = message.reply as HostReply | undefined;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.resolve(reply ?? message);
      }
      return;
    }
    if (kind === 'error' && id) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        const error = new Error(String(message.error ?? '宿主执行失败'));
        error.name = String(message.type ?? 'HostError');
        pending.reject(error);
        return;
      }
      this.emit('event', { runId: id, kind: 'error', payload: message } satisfies HostEvent);
    }
  }

  private send(line: Record<string, unknown>): void {
    if (!this.child) throw new Error('宿主桥未启动');
    this.child.stdin.write(`${JSON.stringify(line)}\n`);
  }

  request<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = `${op}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`宿主桥 ${op} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, op, ...args });
    });
  }

  /** 发起一次真实宿主回合；事件通过 'event' 持续推给调用方。 */
  run(runId: string, request: HostRunRequest): Promise<HostReply> {
    return new Promise<HostReply>((resolve, reject) => {
      this.pending.set(runId, {
        resolve: value => resolve(value as HostReply),
        reject,
      });
      try {
        this.send({ id: runId, op: 'run', ...request });
      } catch (error) {
        this.pending.delete(runId);
        reject(error as Error);
      }
    });
  }

  cancel(runId: string): void {
    if (!this.child) return;
    this.send({ id: runId, op: 'cancel' });
  }

  steer(runId: string, text: string): void {
    if (!this.child) return;
    this.send({ id: runId, op: 'steer', text });
  }

  /** catalog() 和 inventory() 只取桥返回的载荷，不把协议字段带进界面。 */
  async catalog(): Promise<unknown> {
    const result = (await this.request('models', {}, 60_000)) as { catalog?: unknown };
    return result.catalog ?? result;
  }

  async inventory(): Promise<unknown> {
    const result = (await this.request('inventory')) as { inventory?: unknown };
    return result.inventory ?? result;
  }

  get pythonCommand(): string {
    return this.pythonArgs.join(' ');
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
    } catch {
      // 进程可能已经死掉，直接进入 kill
    }
    this.child.kill();
    this.child = undefined;
  }
}

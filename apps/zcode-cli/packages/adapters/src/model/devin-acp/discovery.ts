import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

export interface DevinBinaryResolution {
  readonly path: string;
  readonly version?: string;
}

export class DevinBinaryNotFoundError extends Error {
  constructor() {
    super(
      "Devin CLI 未找到：请安装 devin CLI（devin --version 可用），" +
        "或在 Provider 设置里显式配置 binaryPath。",
    );
    this.name = "DevinBinaryNotFoundError";
  }
}

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_PATTERN = /(\d+\.\d+\.\d+)/;
const EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ""];

/**
 * Windows 的 .cmd/.bat 在 shell:false 下新版 Node 会直接 EINVAL；
 * 这类 shim 必须经 cmd.exe 运行。
 */
export function needsCmdShell(binaryPath: string): boolean {
  return platform() === "win32" && /\.(cmd|bat)$/i.test(binaryPath);
}

/**
 * Devin CLI 二进制发现：access.binaryPath → PATH → 常见安装路径。
 * 只做用户已安装二进制的验证，不分发、不自动安装（与 devin-agent 的不变量一致）。
 */
export async function resolveDevinBinary(
  configuredPath?: string | null,
): Promise<DevinBinaryResolution> {
  const candidates = collectCandidates(configuredPath);
  for (const candidate of candidates) {
    if (!(await isExecutable(candidate))) continue;
    const version = await probeVersion(candidate);
    return { path: candidate, ...(version === undefined ? {} : { version }) };
  }
  throw new DevinBinaryNotFoundError();
}

function collectCandidates(configuredPath?: string | null): string[] {
  const explicit = configuredPath?.trim();
  if (explicit) return [explicit];

  const candidates: string[] = [];
  const pathEnv = process.env.PATH ?? "";
  const isWindows = platform() === "win32";
  // Windows 上无扩展名的 devin 是 shell 脚本 shim，spawn 无法执行，不作候选。
  const names = isWindows ? ["devin.exe", "devin.cmd", "devin.bat"] : ["devin"];
  for (const dir of pathEnv.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) candidates.push(join(trimmed, name));
  }
  candidates.push(join(homedir(), ".local", "bin", isWindows ? "devin.exe" : "devin"));
  if (!isWindows) {
    candidates.push("/usr/local/bin/devin", "/opt/homebrew/bin/devin");
  } else {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const ext of EXECUTABLE_EXTENSIONS) {
        candidates.push(join(localAppData, "Programs", "devin", `devin${ext}`));
      }
    }
  }
  return candidates;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    // Windows 无 X_OK 语义；F_OK 存在即可执行探测版本。
    if (platform() !== "win32") return false;
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

async function probeVersion(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      path,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, shell: needsCmdShell(path) },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const match = VERSION_PATTERN.exec(stdout);
        resolve(match?.[1]);
      },
    );
  });
}

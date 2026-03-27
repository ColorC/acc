import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { platform } from "node:os";

// 由于我们要 mock fs/child_process，需要在 import target 之前设置 mock
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    platform: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  return {
    spawn: vi.fn(),
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as cp from "node:child_process";
import { ScriptAdapter } from "../src/adapters/script.js";

describe("ScriptAdapter Platform Logic", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Windows Platform", () => {
    beforeEach(() => {
      vi.mocked(os.platform).mockReturnValue("win32");
      vi.mocked(fs.readdirSync).mockReturnValue(["test_ps1.ps1", "test_bat.bat", "test_sh.sh", "test_yaml.yaml"] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, mode: 0 } as any);
      vi.mocked(fs.readFileSync).mockReturnValue("#ACC: summary: test\n");
    });

    it("should accept .ps1 and .bat on Windows, ignoring .sh and .yaml", async () => {
      const adapter = new ScriptAdapter({ type: "script", name: "local", path: "/test", group: "util" });
      await adapter.connect();
      const tools = await adapter.listTools();
      
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name).sort()).toEqual(["test_bat", "test_ps1"]);
    });

    it("should use powershell for .ps1 scripts", async () => {
      vi.mocked(fs.readdirSync).mockReturnValue(["test_ps1.ps1"] as any);
      const adapter = new ScriptAdapter({ type: "script", name: "local", path: "/test", group: "util" });
      await adapter.connect();

      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === "close") cb(0);
        }),
      };
      vi.mocked(cp.spawn).mockReturnValue(mockChild as any);

      await adapter.call("test_ps1", { strict: true, name: "world" });

      expect(cp.spawn).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining(["-ExecutionPolicy", "Bypass", "-File", expect.stringContaining("test_ps1.ps1"), "-strict", "-name", "world"]),
        expect.anything()
      );
    });
  });

  describe("Linux/macOS Platform", () => {
    beforeEach(() => {
      vi.mocked(os.platform).mockReturnValue("linux");
      vi.mocked(fs.readdirSync).mockReturnValue(["test_sh.sh", "test_bash.bash", "test_ps1.ps1"] as any);
      // Linux 需要包含可执行权限 (0o111) 才能被认为是合法脚本
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, mode: 0o755 } as any);
      vi.mocked(fs.readFileSync).mockReturnValue("#ACC: summary: test\n");
    });

    it("should accept .sh and .bash on Linux, ignoring .ps1", async () => {
      const adapter = new ScriptAdapter({ type: "script", name: "local", path: "/test", group: "util" });
      await adapter.connect();
      const tools = await adapter.listTools();
      
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name).sort()).toEqual(["test_bash", "test_sh"]);
    });

    it("should reject .sh if no executable bit is set", async () => {
      // 文件无执行权限
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, mode: 0o644 } as any);
      const adapter = new ScriptAdapter({ type: "script", name: "local", path: "/test", group: "util" });
      await adapter.connect();
      const tools = await adapter.listTools();
      
      expect(tools).toHaveLength(0);
    });

    it("should use env vars for passing arguments to .sh", async () => {
      vi.mocked(fs.readdirSync).mockReturnValue(["test_sh.sh"] as any);
      const adapter = new ScriptAdapter({ type: "script", name: "local", path: "/test", group: "util" });
      await adapter.connect();

      const mockChild = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === "close") cb(0);
        }),
      };
      vi.mocked(cp.spawn).mockReturnValue(mockChild as any);

      await adapter.call("test_sh", { name: "world" });

      expect(cp.spawn).toHaveBeenCalledWith(
        expect.stringContaining("test_sh.sh"),
        [],
        expect.objectContaining({
          env: expect.objectContaining({ name: "world" })
        })
      );
    });
  });
});

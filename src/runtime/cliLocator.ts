// Pure helpers for locating the `agy` executable. No fs/Obsidian imports so
// the candidate ordering is unit-testable; the client checks existence.

export interface LocatorEnv {
  LOCALAPPDATA?: string;
  USERPROFILE?: string;
  HOME?: string;
  PATH?: string;
  Path?: string;
}

function joinPath(sep: string, ...parts: string[]): string {
  return parts
    .filter((p) => !!p)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

/**
 * Ordered list of absolute paths where `agy` is likely to live. The
 * configured path (from settings) always comes first. Duplicates removed.
 */
export function cliCandidates(
  configured: string,
  env: LocatorEnv,
  platform: string,
  homeDir: string
): string[] {
  const out: string[] = [];
  const push = (p: string) => {
    const v = (p || "").trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  push(configured);

  if (platform === "win32") {
    const local = env.LOCALAPPDATA || (env.USERPROFILE ? joinPath("\\", env.USERPROFILE, "AppData", "Local") : "");
    if (local) push(joinPath("\\", local, "agy", "bin", "agy.exe"));
    const home = env.USERPROFILE || homeDir;
    if (home) {
      push(joinPath("\\", home, "AppData", "Local", "agy", "bin", "agy.exe"));
      push(joinPath("\\", home, ".local", "bin", "agy.exe"));
    }
  } else {
    const home = env.HOME || homeDir;
    if (home) push(joinPath("/", home, ".local", "bin", "agy"));
    push("/usr/local/bin/agy");
    push("/opt/homebrew/bin/agy");
  }
  return out;
}

/** Split a PATH-like string into directories (platform-aware separator). */
export function splitPathList(pathValue: string | undefined, platform: string): string[] {
  const sep = platform === "win32" ? ";" : ":";
  return (pathValue || "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Binary names to try inside each PATH directory. */
export function cliBinaryNames(platform: string): string[] {
  return platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"];
}

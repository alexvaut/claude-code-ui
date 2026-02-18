import { readFile, lstat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

export interface GitInfo {
  repoUrl: string | null;      // Full URL: https://github.com/owner/repo or git@github.com:owner/repo
  repoId: string | null;       // Normalized: owner/repo
  branch: string | null;       // Current branch name
  rootPath: string | null;     // Absolute path to the git repo root (directory containing .git)
  isGitRepo: boolean;
  isWorktree: boolean;          // Whether this cwd is inside a git worktree
  worktreePath: string | null;  // The worktree checkout root directory (if worktree)
}

/**
 * Result of resolving a .git entry (file or directory).
 */
interface GitDirInfo {
  /** Main .git/ directory — used for reading config (origin URL) */
  mainGitDir: string;
  /** Git dir for reading HEAD — worktree-specific, or same as mainGitDir */
  headGitDir: string;
  /** Whether this is a worktree */
  isWorktree: boolean;
  /** The worktree root directory (dirname of .git file) */
  worktreeRoot: string | null;
}

/**
 * Find the .git entry for a given path, walking up the tree.
 * Handles both normal repos (.git directory) and worktrees (.git file).
 */
async function findGitDirInfo(startPath: string): Promise<GitDirInfo | null> {
  let currentPath = startPath;
  const root = dirname(currentPath) === currentPath ? currentPath : "/";

  while (currentPath !== root) {
    const gitPath = join(currentPath, ".git");
    try {
      const stats = await lstat(gitPath);

      if (stats.isDirectory()) {
        // Normal repo — mainGitDir and headGitDir are the same
        return {
          mainGitDir: gitPath,
          headGitDir: gitPath,
          isWorktree: false,
          worktreeRoot: null,
        };
      }

      if (stats.isFile()) {
        // Worktree — .git is a file containing "gitdir: <path>"
        const content = (await readFile(gitPath, "utf-8")).trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) {
          // Malformed .git file, skip
          currentPath = dirname(currentPath);
          continue;
        }

        // Resolve the worktree git dir (may be relative)
        const worktreeGitDir = resolve(currentPath, match[1].trim());

        // Read commondir to find the main .git directory
        let mainGitDir: string;
        try {
          const commondirContent = (await readFile(join(worktreeGitDir, "commondir"), "utf-8")).trim();
          mainGitDir = resolve(worktreeGitDir, commondirContent);
        } catch {
          // No commondir — fall back to treating worktreeGitDir as main
          mainGitDir = worktreeGitDir;
        }

        return {
          mainGitDir,
          headGitDir: worktreeGitDir,
          isWorktree: true,
          worktreeRoot: currentPath,
        };
      }
    } catch {
      // .git doesn't exist at this level, walk up
    }

    currentPath = dirname(currentPath);
  }

  return null;
}

/**
 * Parse a git remote URL and extract the repo identifier.
 * Handles both HTTPS and SSH formats:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo
 */
function parseGitUrl(url: string): { repoUrl: string; repoId: string } | null {
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/i
  );
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    return {
      repoUrl: `https://github.com/${owner}/${repo}`,
      repoId: `${owner}/${repo}`,
    };
  }

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(
    /^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/i
  );
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return {
      repoUrl: `https://github.com/${owner}/${repo}`,
      repoId: `${owner}/${repo}`,
    };
  }

  // Not a GitHub URL
  return null;
}

/**
 * Read the current branch from .git/HEAD (internal use)
 */
async function _getCurrentBranchInternal(gitDir: string): Promise<string | null> {
  try {
    const headPath = join(gitDir, "HEAD");
    const headContent = await readFile(headPath, "utf-8");
    const trimmed = headContent.trim();

    // HEAD usually contains "ref: refs/heads/branch-name"
    const match = trimmed.match(/^ref: refs\/heads\/(.+)$/);
    if (match) {
      return match[1];
    }

    // Detached HEAD - return null or the short SHA
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the git config file and extract the origin remote URL.
 */
async function getOriginUrl(gitDir: string): Promise<string | null> {
  try {
    const configPath = join(gitDir, "config");
    const configContent = await readFile(configPath, "utf-8");

    // Parse git config format - look for [remote "origin"] section
    const lines = configContent.split("\n");
    let inOriginSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for section header
      if (trimmed.startsWith("[")) {
        inOriginSection = trimmed.toLowerCase() === '[remote "origin"]';
        continue;
      }

      // Look for url = ... in origin section
      if (inOriginSection && trimmed.startsWith("url")) {
        const match = trimmed.match(/^url\s*=\s*(.+)$/);
        if (match) {
          return match[1].trim();
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

const NO_GIT: GitInfo = {
  repoUrl: null, repoId: null, branch: null, rootPath: null,
  isGitRepo: false, isWorktree: false, worktreePath: null,
};

/**
 * Get GitHub repo info for a directory.
 */
export async function getGitInfo(cwd: string): Promise<GitInfo> {
  const gitDirInfo = await findGitDirInfo(cwd);

  if (!gitDirInfo) {
    return NO_GIT;
  }

  // Main repo root (for grouping) — dirname of the main .git directory
  // Normalize drive letter to lowercase on Windows for consistent grouping
  let rootPath = dirname(gitDirInfo.mainGitDir);
  if (/^[A-Z]:/.test(rootPath)) {
    rootPath = rootPath[0].toLowerCase() + rootPath.slice(1);
  }

  const [originUrl, branch] = await Promise.all([
    getOriginUrl(gitDirInfo.mainGitDir),         // Config lives in main .git/
    _getCurrentBranchInternal(gitDirInfo.headGitDir), // HEAD is per-worktree
  ]);

  const base = {
    branch,
    rootPath,
    isGitRepo: true,
    isWorktree: gitDirInfo.isWorktree,
    worktreePath: gitDirInfo.worktreeRoot,
  };

  if (!originUrl) {
    // It's a git repo but has no origin remote
    return { repoUrl: null, repoId: null, ...base };
  }

  const parsed = parseGitUrl(originUrl);

  if (!parsed) {
    // It's a git repo with an origin, but not GitHub
    return { repoUrl: originUrl, repoId: null, ...base };
  }

  return {
    repoUrl: parsed.repoUrl,
    repoId: parsed.repoId,
    ...base,
  };
}

// Cache git info by cwd to avoid repeated filesystem lookups
// Store the HEAD git dir (worktree-specific) for branch refresh
interface CachedGitInfo {
  info: GitInfo;
  headGitDir: string | null;
  lastChecked: number;
}

const gitInfoCache = new Map<string, CachedGitInfo>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * Get GitHub repo info with caching.
 * Repo URL and ID are cached longer, but branch is refreshed more frequently.
 */
export async function getGitInfoCached(cwd: string): Promise<GitInfo> {
  const cached = gitInfoCache.get(cwd);
  const now = Date.now();

  // If we have cached info and it's recent, just refresh the branch
  if (cached && now - cached.lastChecked < CACHE_TTL_MS) {
    // Quick branch refresh
    if (cached.headGitDir) {
      const branch = await getCurrentBranchFromDir(cached.headGitDir);
      if (branch !== cached.info.branch) {
        cached.info = { ...cached.info, branch };
      }
    }
    return cached.info;
  }

  // Full refresh
  const gitDirInfo = await findGitDirInfo(cwd);
  const info = await getGitInfo(cwd);

  gitInfoCache.set(cwd, {
    info,
    headGitDir: gitDirInfo?.headGitDir ?? null,
    lastChecked: now,
  });

  return info;
}

/**
 * Get just the current branch for a cwd.
 * Fast operation that doesn't require full git info lookup.
 */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const cached = gitInfoCache.get(cwd);
  if (cached?.headGitDir) {
    return getCurrentBranchFromDir(cached.headGitDir);
  }

  const gitDirInfo = await findGitDirInfo(cwd);
  if (!gitDirInfo) return null;

  return getCurrentBranchFromDir(gitDirInfo.headGitDir);
}

/**
 * Read the current branch from a known .git directory
 */
async function getCurrentBranchFromDir(gitDir: string): Promise<string | null> {
  try {
    const headPath = join(gitDir, "HEAD");
    const headContent = await readFile(headPath, "utf-8");
    const trimmed = headContent.trim();

    // HEAD usually contains "ref: refs/heads/branch-name"
    const match = trimmed.match(/^ref: refs\/heads\/(.+)$/);
    if (match) {
      return match[1];
    }

    // Detached HEAD - return null or the short SHA
    return null;
  } catch {
    return null;
  }
}

/**
 * Clear git cache for a specific cwd (e.g., after branch change)
 */
export function clearGitCache(cwd: string): void {
  gitInfoCache.delete(cwd);
}

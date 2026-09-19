// Minimal GitHub REST client for reading artworks.json and publishing
// everything (images + JSON) as a single commit via the Git Data API.

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Someone else (another device, a manual commit) changed artworks.json after we loaded it
export class ConflictError extends Error {}

const friendlyMessage = (status, detail) => {
  if (status === 401) return "GitHub rejected the access token. It may be mistyped or expired — create a new one and paste it in Connection settings.";
  if (status === 403) return "The access token doesn't have permission to change this repository. Make sure it has \"Contents: Read and write\" access to this repo.";
  if (status === 404) return "Couldn't find that repository or branch. Check the owner, repository and branch in Connection settings (and that the token has access to this repo).";
  if (status === 409 || status === 422) return "GitHub refused the change because the site was updated at the same moment. Reload from GitHub and try again.";
  return `GitHub returned an error (${status})${detail ? ": " + detail : ""}.`;
};

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const decodeBase64Utf8 = (b64) => {
  const bytes = Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
  }

  async request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
        method,
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError("Couldn't reach GitHub. Check your internet connection and try again.", 0);
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).message || "";
      } catch {}
      throw new GitHubError(friendlyMessage(response.status, detail), response.status);
    }
    return response.status === 204 ? null : response.json();
  }

  // Confirms the repo and branch exist and the token can see them
  async checkAccess() {
    const repo = await this.request("");
    await this.request(`/branches/${this.branch}`);
    return repo;
  }

  // Returns { data, sha } or { data: null, sha: null } if the file doesn't exist yet
  async readJson(path, ref = this.branch) {
    try {
      const file = await this.request(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
      return { data: JSON.parse(decodeBase64Utf8(file.content)), sha: file.sha };
    } catch (error) {
      if (error.status === 404) {
        // Distinguish "file missing" from "repo/branch missing"
        await this.request(`/branches/${this.branch}`);
        return { data: null, sha: null };
      }
      throw error;
    }
  }

  async fileSha(path, ref) {
    try {
      return (await this.request(`/contents/${path}?ref=${encodeURIComponent(ref)}`)).sha;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Commits all changes at once.
   * uploads: [{ path, blob }]      new binary files
   * textFiles: [{ path, text }]    new/updated text files
   * deletions: [path]              files to remove (ignored if already gone)
   * guard: { path, sha }           abort with ConflictError if this file changed
   * Returns { commitSha, shas: { [path]: blobSha } } for top-level text files.
   */
  async commit({ uploads = [], textFiles = [], deletions = [], guard, message, onProgress = () => {} }) {
    const branchPath = `/git/ref/heads/${this.branch}`;
    onProgress("Checking for changes made elsewhere…");
    const headSha = (await this.request(branchPath)).object.sha;

    if (guard && (await this.fileSha(guard.path, headSha)) !== guard.sha) {
      throw new ConflictError("The artwork list on GitHub changed since you loaded it.");
    }

    const headCommit = await this.request(`/git/commits/${headSha}`);
    const existing = await this.request(`/git/trees/${headCommit.tree.sha}?recursive=1`);
    const existingPaths = new Set(existing.tree.map((entry) => entry.path));

    const tree = [];
    for (let i = 0; i < uploads.length; i++) {
      onProgress(`Uploading image ${i + 1} of ${uploads.length}…`);
      const blob = await this.request("/git/blobs", {
        method: "POST",
        body: { content: await blobToBase64(uploads[i].blob), encoding: "base64" },
      });
      tree.push({ path: uploads[i].path, mode: "100644", type: "blob", sha: blob.sha });
    }
    textFiles.forEach(({ path, text }) => {
      tree.push({ path, mode: "100644", type: "blob", content: text });
    });
    deletions
      .filter((path) => existingPaths.has(path))
      .forEach((path) => tree.push({ path, mode: "100644", type: "blob", sha: null }));

    onProgress("Saving…");
    const newTree = await this.request("/git/trees", {
      method: "POST",
      body: { base_tree: headCommit.tree.sha, tree },
    });
    const newCommit = await this.request("/git/commits", {
      method: "POST",
      body: { message, tree: newTree.sha, parents: [headSha] },
    });
    // Not forced: fails if the branch moved while we were uploading
    await this.request(`/git/refs/heads/${this.branch}`, {
      method: "PATCH",
      body: { sha: newCommit.sha },
    });

    const shas = {};
    newTree.tree.forEach((entry) => (shas[entry.path] = entry.sha));
    return { commitSha: newCommit.sha, shas };
  }
}

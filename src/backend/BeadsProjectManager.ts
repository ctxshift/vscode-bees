import * as crypto from "crypto";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { resolveEnvVariables } from "../utils/resolve-env-variables";
import { BeadsBackend } from "./BeadsBackend";
import { BeadsBeesBackend } from "./BeadsBeesBackend";
import { BeadsProject } from "./types";

const ACTIVE_PROJECT_KEY = "bees.activeProjectId";
const execFileAsync = util.promisify(execFile);

type BackendStatusState = "running" | "stopped" | "zombie" | "not_initialized" | "unknown";

export class BeadsProjectManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly log: Logger;
  private projects: BeadsProject[] = [];
  private activeProject: BeadsProject | null = null;
  private backend: BeadsBackend | null = null;

  private activePollTimer: NodeJS.Timeout | null = null;
  private activePollToken: string | null = null;

  private readonly _onProjectsChanged = new vscode.EventEmitter<BeadsProject[]>();
  public readonly onProjectsChanged = this._onProjectsChanged.event;

  private readonly _onActiveProjectChanged = new vscode.EventEmitter<BeadsProject | null>();
  public readonly onActiveProjectChanged = this._onActiveProjectChanged.event;

  private readonly _onDataChanged = new vscode.EventEmitter<void>();
  public readonly onDataChanged = this._onDataChanged.event;

  constructor(context: vscode.ExtensionContext, logger: Logger) {
    this.context = context;
    this.log = logger.child("ProjectManager");
  }

  async initialize(): Promise<void> {
    await this.discoverProjects();

    if (this.projects.length > 0 && !this.activeProject) {
      const savedProjectId = this.context.workspaceState.get<string>(ACTIVE_PROJECT_KEY);
      const targetProject = savedProjectId
        ? this.projects.find((p) => p.id === savedProjectId)
        : undefined;
      await this.setActiveProject(targetProject?.id ?? this.projects[0].id);
    }
  }

  async discoverProjects(): Promise<void> {
    const discoveredById = new Map<string, BeadsProject>();

    const configuredProjects = await Promise.all(
      this.getConfiguredProjectPaths().map((explicitPath) => this.createProjectFromInputPath(explicitPath, "setting"))
    );
    for (const project of configuredProjects) {
      if (project && !discoveredById.has(project.id)) discoveredById.set(project.id, project);
    }

    const envBeadsDir = process.env.BEADS_DIR?.trim();
    if (envBeadsDir) {
      const project = await this.createProjectFromInputPath(envBeadsDir, "env");
      if (project && !discoveredById.has(project.id)) discoveredById.set(project.id, project);
    }

    const workspaceProjects = await Promise.all(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => this.createProjectFromInputPath(folder.uri.fsPath, "workspace"))
    );
    for (const project of workspaceProjects) {
      if (project && !discoveredById.has(project.id)) discoveredById.set(project.id, project);
    }

    const discoveredProjects = Array.from(discoveredById.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.projects = discoveredProjects;
    this._onProjectsChanged.fire(this.projects);
  }

  getProjects(): BeadsProject[] {
    return this.projects;
  }

  getActiveProject(): BeadsProject | null {
    return this.activeProject;
  }

  getBackend(): BeadsBackend | null {
    return this.backend;
  }

  getClient(): BeadsBackend | null {
    return this.backend;
  }

  async setActiveProject(projectId: string): Promise<boolean> {
    let project = this.projects.find((p) => p.id === projectId);
    if (!project) {
      this.log.warn(`Project ${projectId} not found in current cache; rediscovering.`);
      await this.discoverProjects();
      project = this.projects.find((p) => p.id === projectId);
    }

    if (!project) {
      this.log.warn(`Project ${projectId} still not found after rediscovery.`);
      return false;
    }

    this.log.info(`Switching active project to ${project.name} (${project.id})`);

    await this.activateProject(project, { emitActiveProjectChanged: true, persistSelection: true, emitDataChanged: false });
    return true;
  }

  async refresh(): Promise<void> {
    await this.discoverProjects();

    const activeId = this.activeProject?.id;
    if (!activeId) {
      if (this.projects.length > 0) {
        await this.setActiveProject(this.projects[0].id);
      }
      this._onDataChanged.fire();
      return;
    }

    const stillExists = this.projects.some((p) => p.id === activeId);
    if (!stillExists) {
      this.activeProject = null;
      this.backend = null;
      this._onActiveProjectChanged.fire(null);
      this._onDataChanged.fire();
      return;
    }

    const activeProject = this.projects.find((project) => project.id === activeId);
    if (activeProject) {
      await this.activateProject(activeProject, {
        emitActiveProjectChanged: false,
        persistSelection: false,
        emitDataChanged: true,
      });
    }
  }

  async getBackendStatus(): Promise<{ state: BackendStatusState; message: string; details?: Record<string, unknown> }> {
    if (!this.activeProject || !this.backend) {
      return { state: "unknown", message: "No active project" };
    }

    const compatibility = await this.backend.checkCompatibility();
    if (!compatibility.supported) {
      return {
        state: "stopped",
        message: compatibility.message,
        details: {
          detectedVersion: compatibility.detectedVersion,
          minimumVersion: compatibility.minimumVersion,
        },
      };
    }

    try {
      await this.backend.probeLive();
    } catch (error) {
      if (this.isNotInitializedError(error)) {
        return {
          state: "not_initialized",
          message: "Bees project is not initialized. Run `bees init` in this project. See Output > Bees for details.",
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        state: "zombie",
        message,
        details: {
          beadsDir: this.activeProject.beadsDir,
          detectedVersion: compatibility.detectedVersion,
          minimumVersion: compatibility.minimumVersion,
        },
      };
    }

      return {
        state: "running",
        message: compatibility.message,
        details: {
          beadsDir: this.activeProject.beadsDir,
        },
      };
  }

  async showProjectPicker(): Promise<BeadsProject | undefined> {
    if (this.projects.length === 0) {
      vscode.window.showWarningMessage("No Bees projects found. Initialize a project with `bees init` first.");
      return undefined;
    }

    const items = this.projects.map((project) => ({
      label: project.name,
      description: project.rootPath,
      project,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a Bees project",
      title: "Switch Bees Project",
    });

    if (!selected) return undefined;
    await this.setActiveProject(selected.project.id);
    return selected.project;
  }

  async notifyBackendError(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.log.trace(`Backend error: ${message}`);
  }

  dispose(): void {
    if (this.activePollTimer) {
      clearInterval(this.activePollTimer);
      this.activePollTimer = null;
    }
    this._onProjectsChanged.dispose();
    this._onActiveProjectChanged.dispose();
    this._onDataChanged.dispose();
  }

  private getConfiguredProjectPaths(): string[] {
    const config = vscode.workspace.getConfiguration("bees");
    const configured = config.get<string[]>("projects", []);
    return configured.filter((value) => typeof value === "string" && value.trim().length > 0);
  }

  private async createProjectFromInputPath(inputPath: string, source: BeadsProject["source"]): Promise<BeadsProject | null> {
    const resolvedInput = path.resolve(inputPath);
    const stats = await this.tryStat(resolvedInput);
    if (!stats) return null;

    const rootPath = path.basename(resolvedInput) === ".beads" ? path.dirname(resolvedInput) : resolvedInput;
    const explicitBeadsDir = path.basename(resolvedInput) === ".beads" ? resolvedInput : undefined;
    const projectProbe = await this.probeBeadsProject(rootPath, explicitBeadsDir);
    if (!projectProbe) return null;

    const folderName = this.getProjectDisplayName(rootPath, projectProbe.beadsDir);

    return {
      id: this.generateProjectId(projectProbe.beadsDir),
      name: folderName,
      rootPath,
      beadsDir: projectProbe.beadsDir,
      backendStatus: "running",
      source,
    };
  }

  private async probeBeadsProject(
    rootPath: string,
    explicitBeadsDir?: string
  ): Promise<{ beadsDir: string } | null> {
    // bees stores its database under `.bees/` and (on Unix) also exposes a
    // `.beads` symlink for compatibility. Discovery is a filesystem check —
    // no CLI invocation — so it works identically on every platform.
    const candidates = explicitBeadsDir
      ? [explicitBeadsDir]
      : [path.join(rootPath, ".bees"), path.join(rootPath, ".beads")];

    for (const candidate of candidates) {
      const stats = await this.tryStat(candidate);
      if (stats && stats.isDirectory()) {
        this.log.debug(`Discovered bees project at ${candidate}`);
        return { beadsDir: path.resolve(candidate) };
      }
    }

    this.log.trace(`No bees project found under ${rootPath}`);
    return null;
  }

  private getProjectDisplayName(rootPath: string, beadsDir: string): string {
    const workspaceName = path.basename(rootPath) || rootPath;
    const canonicalRepoName = path.basename(path.dirname(beadsDir));

    if (!canonicalRepoName || canonicalRepoName === workspaceName) {
      return workspaceName;
    }

    return `${canonicalRepoName} (${workspaceName})`;
  }

  private generateProjectId(beadsDir: string): string {
    return crypto.createHash("sha256").update(beadsDir).digest("hex").slice(0, 12);
  }

  private syncActiveProjectPolling(): void {
    if (this.activePollTimer) {
      clearInterval(this.activePollTimer);
      this.activePollTimer = null;
    }
    this.activePollToken = null;

    const project = this.activeProject;
    const backend = this.backend;
    if (!project || !backend) return;

    const intervalMs = Math.max(
      0,
      vscode.workspace.getConfiguration("bees").get<number>("refreshInterval", 0)
    );
    if (intervalMs === 0) return;

    this.log.debug(`Watching Dolt changes for ${project.name} every ${intervalMs}ms`);

    const poll = async () => {
      if (this.activeProject?.id !== project.id || this.backend !== backend) return;
      try {
        this.log.trace(`Polling Dolt change token for ${project.name}`);
        const token = await backend.getChangeToken();
        if (!token) return;
        if (this.activePollToken === null) {
          this.activePollToken = token;
          this.log.debug(`Initialized Dolt change token for ${project.name}`);
          return;
        }
        if (token !== this.activePollToken) {
          this.activePollToken = token;
          this.log.debug(`Detected Dolt change for ${project.name}`);
          this._onDataChanged.fire();
        }
      } catch (error) {
        this.log.trace(`Active project poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    void poll();
    this.activePollTimer = setInterval(() => {
      void poll();
    }, intervalMs);
  }

  private async tryStat(target: string): Promise<fs.Stats | null> {
    try {
      return await fs.promises.stat(target);
    } catch {
      return null;
    }
  }

  private async activateProject(
    project: BeadsProject,
    options: { emitActiveProjectChanged: boolean; persistSelection: boolean; emitDataChanged: boolean }
  ): Promise<void> {
    const oldBackend = this.backend;
    if (oldBackend) {
      await oldBackend.dispose();
    }

    this.activeProject = project;

    if (options.persistSelection) {
      await this.context.workspaceState.update(ACTIVE_PROJECT_KEY, project.id);
    }

    const beesPath = await this.resolveBeesExecutable(project.rootPath);

    this.backend = new BeadsBeesBackend({
      beesPath,
      cwd: project.rootPath,
      beadsDir: project.beadsDir,
      log: this.log,
    });

    project.backendStatus = "unknown";
    this.activePollToken = null;

    if (options.emitActiveProjectChanged) {
      this._onActiveProjectChanged.fire(project);
    }

    this.syncActiveProjectPolling();

    if (options.emitDataChanged) {
      this._onDataChanged.fire();
    }

    const compatibility = await this.backend.checkCompatibility();
    project.backendStatus = compatibility.supported ? "running" : "stopped";
    if (compatibility.supported) {
      try {
        this.activePollToken = await this.backend.getChangeToken();
      } catch (error) {
        this.log.trace(`Failed to initialize change token: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private resolveBdPath(configuredPath: string): string {
    const raw = configuredPath || "bees";
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const resolvedPath = workspaceRoot && !path.isAbsolute(raw) ? path.resolve(workspaceRoot, raw) : raw;

    if (resolvedPath !== raw && fs.existsSync(resolvedPath)) {
      return resolvedPath;
    }

    if (path.isAbsolute(raw) || raw === "bees") {
      return raw;
    }

    return fs.existsSync(raw) ? raw : "bees";
  }

  private getBdPath(): string {
    const config = vscode.workspace.getConfiguration("bees");
    const configuredBdPath = config.get<string>("pathToBd", "bees") ?? "bees";
    return this.resolveBdPath(resolveEnvVariables(configuredBdPath).trim());
  }

  /**
   * Resolve the bees executable to spawn for `cwd`.
   *
   * Node spawns without a shell, so a bare name or a mise/asdf shim (a script,
   * not a real .exe) fails on Windows with ENOENT. When the configured path is
   * a bare name or a mise shim, ask `mise which bees` (run in the project dir,
   * so per-project tool versions are respected) for the real binary. An
   * explicit, existing executable path is always honored as-is.
   */
  private async resolveBeesExecutable(cwd: string): Promise<string> {
    const configured = this.getBdPath();

    // An explicit path to a real (non-shim) file wins outright.
    if (path.isAbsolute(configured) && fs.existsSync(configured) && !this.isMiseShim(configured)) {
      return configured;
    }

    const useMise = vscode.workspace.getConfiguration("bees").get<boolean>("useMise", true);
    if (useMise) {
      const toolName = this.toolBaseName(configured);
      const viaMise = await this.resolveViaMise(toolName, cwd);
      if (viaMise) {
        this.log.debug(`Resolved '${toolName}' via mise: ${viaMise}`);
        return viaMise;
      }
    }

    return configured;
  }

  private isMiseShim(candidate: string): boolean {
    return /[\\/](?:mise|asdf)[\\/]shims[\\/]/i.test(candidate);
  }

  private toolBaseName(candidate: string): string {
    const base = path.basename(candidate).replace(/\.(exe|cmd|bat|ps1)$/i, "");
    return base || "bees";
  }

  private async resolveViaMise(toolName: string, cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("mise", ["which", toolName], {
        cwd,
        env: { ...process.env },
        timeout: 10000,
      });
      const resolved = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      if (resolved && fs.existsSync(resolved)) {
        return resolved;
      }
      this.log.trace(`mise which ${toolName} returned no usable path`);
    } catch (error) {
      this.log.trace(`mise which ${toolName} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  private isNotInitializedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    const missingNamedDatabase = normalized.includes('database "') && normalized.includes('" not found');
    return normalized.includes("not initialized") || missingNamedDatabase;
  }
}

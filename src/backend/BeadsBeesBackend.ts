import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import { Logger } from "../utils/logger";
import {
  AddCommentArgs,
  BackendCompatibility,
  BeadsBackend,
  BeadsIssue,
  CloseIssueArgs,
  CreateIssueArgs,
  DependencyArgs,
  UpdateIssueArgs,
} from "./BeadsBackend";

const execFileAsync = util.promisify(execFile);
const BEES_COMMAND_TIMEOUT_MS = 30000;

function errMessage(error: unknown): string {
  const err = error as Error & { stderr?: string; stdout?: string };
  const stderr = err?.stderr?.toString().trim() ?? "";
  const stdout = err?.stdout?.toString().trim() ?? "";
  return stderr || stdout || (error instanceof Error ? error.message : String(error));
}

/**
 * Backend that talks to the `bees` CLI (https://github.com/code0100fun/bees).
 *
 * Unlike the upstream Dolt backend, bees is a single static binary backed by a
 * local SQLite database. Every operation shells out to `bees <command> --json`
 * via execFile (no shell, no socket, no server), so this backend works
 * identically on Linux, macOS, and Windows (`bees.exe`).
 */
export class BeadsBeesBackend implements BeadsBackend {
  private readonly beesPath: string;
  private readonly cwd: string;
  private readonly beadsDir: string;
  private readonly log: Logger;
  private compatibilityPromise: Promise<BackendCompatibility> | null = null;

  constructor(params: { beesPath: string; cwd: string; beadsDir: string; log: Logger }) {
    this.beesPath = params.beesPath;
    this.cwd = params.cwd;
    this.beadsDir = params.beadsDir;
    this.log = params.log.child("BeesBackend");
  }

  async dispose(): Promise<void> {
    this.compatibilityPromise = null;
  }

  async checkCompatibility(): Promise<BackendCompatibility> {
    this.compatibilityPromise ??= this.computeCompatibility();
    return this.compatibilityPromise;
  }

  private async computeCompatibility(): Promise<BackendCompatibility> {
    // bees has no `version` subcommand, so compatibility is established by
    // confirming the binary runs and the project responds to a read.
    try {
      await this.run(["list", "--json"]);
      return {
        supported: true,
        minimumVersion: "0.0.0",
        message: `bees backend ready (${this.beesPath})`,
      };
    } catch (error) {
      return {
        supported: false,
        minimumVersion: "0.0.0",
        message: `Unable to run bees at '${this.beesPath}': ${errMessage(error)}`,
      };
    }
  }

  async probeLive(): Promise<void> {
    await this.runJson(["list", "--json"]);
  }

  async info(): Promise<Record<string, unknown>> {
    const issues = await this.list();
    return {
      database: path.join(this.beadsDir, "bees.db"),
      mode: "sqlite",
      issue_count: issues.length,
    };
  }

  async getChangeToken(): Promise<string | null> {
    // bees rewrites bees.db (and issues.jsonl) on every mutation, so the
    // database file's mtime+size is a cheap change token for poll-based refresh.
    try {
      const st = await fs.promises.stat(path.join(this.beadsDir, "bees.db"));
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  // bees uses an embedded SQLite database; there is no Dolt server to manage.
  // These remain so the interface (and the existing UI commands) stay intact.
  async doltStatus(): Promise<string> {
    return "bees uses an embedded SQLite database; no Dolt server is involved.";
  }

  async startDoltServer(): Promise<string> {
    return "bees uses an embedded SQLite database; there is no Dolt server to start.";
  }

  async stopDoltServer(): Promise<string> {
    return "bees uses an embedded SQLite database; there is no Dolt server to stop.";
  }

  async list(): Promise<BeadsIssue[]> {
    const result = await this.runJson(["list", "--json"]);
    return Array.isArray(result) ? (result as BeadsIssue[]) : [];
  }

  async show(id: string): Promise<BeadsIssue | null> {
    const result = await this.runJson(["show", id, "--json"]);
    if (Array.isArray(result)) {
      return (result[0] as BeadsIssue | undefined) ?? null;
    }
    return (result as BeadsIssue) ?? null;
  }

  async create(args: CreateIssueArgs): Promise<BeadsIssue> {
    const cmdArgs = [
      "create",
      args.title,
      "--type",
      args.issue_type ?? "task",
      "--priority",
      String(args.priority ?? 2),
      "--json",
    ];
    if (args.description) cmdArgs.push("--description", args.description);
    if (args.design) cmdArgs.push("--design", args.design);
    if (args.acceptance_criteria) cmdArgs.push("--acceptance", args.acceptance_criteria);
    if (args.assignee) cmdArgs.push("--assignee", args.assignee);

    const created = (await this.runJson(cmdArgs)) as { id?: string };
    const id = created?.id;
    if (!id) {
      throw new Error("bees create did not return an issue id");
    }

    // bees has no --label on create; labels are a separate command.
    for (const label of args.labels ?? []) {
      await this.run(["label", "add", id, label]);
    }

    return this.requireIssue(id, "create");
  }

  async update(args: UpdateIssueArgs): Promise<BeadsIssue> {
    const cmdArgs = ["update", args.id, "--json"];
    if (args.title !== undefined) cmdArgs.push("--title", args.title);
    if (args.description !== undefined) cmdArgs.push("--description", args.description);
    if (args.design !== undefined) cmdArgs.push("--design", args.design);
    if (args.acceptance_criteria !== undefined) cmdArgs.push("--acceptance", args.acceptance_criteria);
    if (args.notes !== undefined) cmdArgs.push("--notes", args.notes);
    if (args.status !== undefined) cmdArgs.push("--status", args.status);
    if (args.priority !== undefined) cmdArgs.push("--priority", String(args.priority));
    if (args.assignee !== undefined) cmdArgs.push("--assignee", args.assignee);
    if (args.external_ref !== undefined) cmdArgs.push("--external-ref", args.external_ref);

    const issueType = args.issue_type ?? args.type;
    if (issueType !== undefined) cmdArgs.push("--type", issueType);

    if ((args.estimated_minutes ?? args.estimate) !== undefined) {
      this.log.debug("bees has no estimate field; ignoring estimate on update.");
    }

    // Avoid a no-op `bees update` (which would error) when only labels change.
    const hasFieldChange = cmdArgs.length > 3;
    if (hasFieldChange) {
      await this.run(cmdArgs);
    }

    await this.applyLabelChanges(args);

    return this.requireIssue(args.id, "update");
  }

  private async applyLabelChanges(args: UpdateIssueArgs): Promise<void> {
    if (args.set_labels) {
      const current = (await this.show(args.id))?.labels ?? [];
      const target = new Set(args.set_labels);
      for (const label of current) {
        if (!target.has(label)) await this.run(["label", "remove", args.id, label]);
      }
      for (const label of args.set_labels) {
        if (!current.includes(label)) await this.run(["label", "add", args.id, label]);
      }
      return;
    }

    for (const label of args.add_labels ?? []) {
      await this.run(["label", "add", args.id, label]);
    }
    for (const label of args.remove_labels ?? []) {
      await this.run(["label", "remove", args.id, label]);
    }
  }

  async close(args: CloseIssueArgs): Promise<BeadsIssue> {
    const cmdArgs = ["close", args.id, "--json"];
    if (args.reason) cmdArgs.push("--reason", args.reason);
    await this.run(cmdArgs);
    return this.requireIssue(args.id, "close");
  }

  async addDependency(args: DependencyArgs): Promise<void> {
    const depType = args.dep_type ?? "blocks";
    await this.run(["dep", "add", args.from_id, args.to_id, "--type", depType]);
  }

  async removeDependency(args: DependencyArgs): Promise<void> {
    const cmdArgs = ["dep", "remove", args.from_id, args.to_id];
    if (args.dep_type) cmdArgs.push("--type", args.dep_type);
    await this.run(cmdArgs);
  }

  async listComments(
    id: string
  ): Promise<Array<{ id: string; author: string; text: string; created_at: string }>> {
    const result = await this.runJson(["comment", "list", id, "--json"]);
    return Array.isArray(result)
      ? (result as Array<{ id: string; author: string; text: string; created_at: string }>)
      : [];
  }

  async addComment(args: AddCommentArgs): Promise<void> {
    const cmdArgs = ["comment", "add", args.id, args.text, "--json"];
    if (args.author) cmdArgs.push("--author", args.author);
    await this.run(cmdArgs);
  }

  private async requireIssue(id: string, operation: string): Promise<BeadsIssue> {
    const issue = await this.show(id);
    if (!issue) {
      throw new Error(`bees ${operation} succeeded but issue ${id} could not be read back`);
    }
    return issue;
  }

  private async run(args: string[]): Promise<string> {
    const commandLabel = [this.beesPath, ...args].join(" ");
    this.log.debug(`Running: ${commandLabel} (cwd=${this.cwd})`);
    try {
      const { stdout, stderr } = await execFileAsync(this.beesPath, args, {
        cwd: this.cwd,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
        timeout: BEES_COMMAND_TIMEOUT_MS,
        killSignal: "SIGTERM",
      });
      const out = stdout?.trim() ?? "";
      const errOut = stderr?.trim() ?? "";
      if (errOut) this.log.trace(`stderr: ${errOut}`);
      return out;
    } catch (error) {
      const message = errMessage(error);
      this.log.trace(`bees command failed: ${args.join(" ")} :: ${message}`);
      throw new Error(message);
    }
  }

  private async runJson(args: string[]): Promise<unknown> {
    const out = await this.run(args);
    if (!out) return [];
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`bees returned non-JSON output for '${args.join(" ")}': ${out.slice(0, 200)}`);
    }
  }
}

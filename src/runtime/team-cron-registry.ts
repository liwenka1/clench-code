export type TeamStatus = "created" | "running" | "completed" | "deleted";

export interface Team {
  teamId: string;
  name: string;
  taskIds: string[];
  status: TeamStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CronEntry {
  cronId: string;
  schedule: string;
  prompt: string;
  description?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  runCount: number;
}

export interface TeamRegistrySnapshot {
  teams: Team[];
  counter: number;
}

export interface CronRegistrySnapshot {
  entries: CronEntry[];
  counter: number;
}

export class TeamRegistry {
  private readonly teams = new Map<string, Team>();
  private counter = 0;

  constructor(snapshot?: TeamRegistrySnapshot) {
    for (const team of snapshot?.teams ?? []) {
      this.teams.set(team.teamId, cloneTeam(team));
    }
    this.counter = snapshot?.counter ?? 0;
  }

  create(name: string, taskIds: string[]): Team {
    this.counter += 1;
    const ts = nowSecs();
    const teamId = `team_${ts.toString(16).padStart(8, "0")}_${this.counter}`;
    const team: Team = {
      teamId,
      name,
      taskIds: [...taskIds],
      status: "created",
      createdAt: ts,
      updatedAt: ts
    };
    this.teams.set(teamId, team);
    return cloneTeam(team);
  }

  get(teamId: string): Team | undefined {
    const team = this.teams.get(teamId);
    return team ? cloneTeam(team) : undefined;
  }

  list(): Team[] {
    return [...this.teams.values()].map(cloneTeam);
  }

  delete(teamId: string): Team {
    const team = this.mustGetTeam(teamId);
    team.status = "deleted";
    team.updatedAt = nowSecs();
    return cloneTeam(team);
  }

  remove(teamId: string): Team | undefined {
    const team = this.teams.get(teamId);
    if (!team) {
      return undefined;
    }
    this.teams.delete(teamId);
    return cloneTeam(team);
  }

  len(): number {
    return this.teams.size;
  }

  isEmpty(): boolean {
    return this.teams.size === 0;
  }

  snapshot(): TeamRegistrySnapshot {
    return {
      teams: [...this.teams.values()].map(cloneTeam),
      counter: this.counter
    };
  }

  private mustGetTeam(teamId: string): Team {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`team not found: ${teamId}`);
    }
    return team;
  }
}

export class CronRegistry {
  private readonly entries = new Map<string, CronEntry>();
  private counter = 0;

  constructor(snapshot?: CronRegistrySnapshot) {
    for (const entry of snapshot?.entries ?? []) {
      this.entries.set(entry.cronId, cloneCron(entry));
    }
    this.counter = snapshot?.counter ?? 0;
  }

  create(schedule: string, prompt: string, description?: string): CronEntry {
    this.counter += 1;
    const ts = nowSecs();
    const cronId = `cron_${ts.toString(16).padStart(8, "0")}_${this.counter}`;
    const entry: CronEntry = {
      cronId,
      schedule,
      prompt,
      description,
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
      runCount: 0
    };
    this.entries.set(cronId, entry);
    return cloneCron(entry);
  }

  get(cronId: string): CronEntry | undefined {
    const entry = this.entries.get(cronId);
    return entry ? cloneCron(entry) : undefined;
  }

  list(enabledOnly: boolean): CronEntry[] {
    return [...this.entries.values()]
      .filter((entry) => !enabledOnly || entry.enabled)
      .map(cloneCron);
  }

  delete(cronId: string): CronEntry {
    const entry = this.entries.get(cronId);
    if (!entry) {
      throw new Error(`cron not found: ${cronId}`);
    }
    this.entries.delete(cronId);
    return cloneCron(entry);
  }

  disable(cronId: string): void {
    const entry = this.mustGetCron(cronId);
    entry.enabled = false;
    entry.updatedAt = nowSecs();
  }

  recordRun(cronId: string): void {
    const entry = this.mustGetCron(cronId);
    entry.lastRunAt = nowSecs();
    entry.runCount += 1;
    entry.updatedAt = nowSecs();
  }

  len(): number {
    return this.entries.size;
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  snapshot(): CronRegistrySnapshot {
    return {
      entries: [...this.entries.values()].map(cloneCron),
      counter: this.counter
    };
  }

  private mustGetCron(cronId: string): CronEntry {
    const entry = this.entries.get(cronId);
    if (!entry) {
      throw new Error(`cron not found: ${cronId}`);
    }
    return entry;
  }
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function cloneTeam(team: Team): Team {
  return {
    ...team,
    taskIds: [...team.taskIds]
  };
}

function cloneCron(entry: CronEntry): CronEntry {
  return { ...entry };
}
